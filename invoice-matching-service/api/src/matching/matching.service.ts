import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { AccountingSource, type PurchaseOrder, type SupplierRecord } from "./accounting/accounting.source.js";
import {
  CheckerService,
  type CheckResult,
  type LineComparison,
  type Outcome,
  type PoFoundBy,
} from "./checker/checker.service.js";
import { INVOICE_TYPES, monthOf, type MonthFrom, type ReadBy, type StandardInvoice } from "./invoice.schema.js";
import { normalizeInvoice, normId, normName } from "./normalize.js";
import type { PoRead } from "./po.schema.js";
import { findKeyedPo, findPoAlreadyBilledBy, isPoSupplier, poBillingKey } from "./po-lookup.js";
import { RetryableError } from "./reader/errors.js";
import { ReaderService } from "./reader/reader.service.js";
import type { TextractRead } from "./reader/textract.reader.js";
import { uploadedPo } from "./uploaded-po.js";

/** The slow part (AI), kept so the checks can be re-run later without reading the file again. */
export interface ReadResult {
  invoice: StandardInvoice | null;
  readBy: ReadBy | null;
  model: string | null;
  error: string | null;
  /** True for temporary problems (rate limit, server busy/down, timeout): worth trying again later. */
  retryable: boolean;
  /** What Amazon Textract found on the same pages (PDFs, photos, scans), for check 0. */
  textract?: TextractRead | null;
  seconds: number;
}

/** The PO uploaded with an invoice (screenshots of our system's PO page), as read by Bedrock. */
export interface PoReadResult {
  po: PoRead | null;
  model: string | null;
  error: string | null;
  /** True for temporary problems (rate limit, server busy/down, timeout): worth trying again later. */
  retryable: boolean;
  seconds: number;
}

/** Everything the checks found for one file: what the page shows and the command line saves. */
export interface InvoiceResult {
  file: string;
  outcome: Outcome;
  readBy: ReadBy | null;
  model: string | null;
  invoice: StandardInvoice | null;
  checks: CheckResult[];
  error: string | null;
  /** What the invoice was compared with: our supplier record, the PO (and how it was found), and line by line. */
  context: {
    supplier: SupplierRecord | null;
    po: PurchaseOrder | null;
    poFoundBy: PoFoundBy;
    /** The month the invoice is for, and where that came from. */
    month: { value: string | null; from: MonthFrom | null };
    lines: LineComparison[];
  } | null;
  /** Same supplier + invoice number = same invoice (for the duplicate check). */
  invoiceKey: string | null;
}

/**
 * Invoices seen before this one: file fingerprint → name, invoice key → name,
 * PO (a recurring PO: PO + month, see poBillingKey) → the first invoice billing it.
 */
export interface Seen {
  byHash: Map<string, string>;
  byKey: Map<string, string>;
  byPo: Map<string, string>;
}

/** Nothing seen yet: the start of a batch, or of a re-check of the whole queue. */
export const emptySeen = (): Seen => ({ byHash: new Map(), byKey: new Map(), byPo: new Map() });

/** What an invoice holds for the duplicate check (kept while it is read again, so later copies stay flagged). */
export interface Claims {
  invoiceKey: string | null;
  /** The PO it bills (poBillingKey), or null. */
  poKey: string | null;
}

/** READ → MAP → MATCH → FLAG for one invoice. Used by the command line (BatchService) and the web UI. */
@Injectable()
export class MatchingService {
  constructor(
    private readonly reader: ReaderService,
    private readonly checker: CheckerService,
    private readonly accounting: AccountingSource,
  ) {}

  /** The file's SHA-256: the same file sent twice is a duplicate, whatever it is called. */
  fingerprint(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
  }

  /** READ the PO uploaded with an invoice. Never throws: a PO that can't be read sends the invoice to REVIEW. */
  async readPo(files: { name: string; data: Buffer }[]): Promise<PoReadResult> {
    const seconds = timer();
    try {
      const { po, model } = await this.reader.readPo(files);
      return { po, model, error: null, retryable: false, seconds: seconds() };
    } catch (error) {
      return { po: null, model: null, error: messageOf(error), retryable: error instanceof RetryableError, seconds: seconds() };
    }
  }

  /** READ. Never throws: a file that can't be read becomes an error the checks turn into REVIEW. */
  async read(fileName: string, data: Buffer): Promise<ReadResult> {
    const seconds = timer();
    try {
      const { invoice, readBy, model, textract } = await this.reader.read(fileName, data);
      return { invoice, readBy, model, error: null, retryable: false, textract, seconds: seconds() };
    } catch (error) {
      return {
        invoice: null,
        readBy: null,
        model: null,
        error: messageOf(error),
        retryable: error instanceof RetryableError,
        seconds: seconds(),
      };
    }
  }

  /**
   * MAP + MATCH + FLAG. Fast (no AI), so it can be re-run any time, e.g. after the PO data changes.
   * Never throws: if the checks themselves fail (e.g. a PO keyed with a broken number), the invoice goes to Review
   * with the reason. `approved`: a person approved this invoice, so it may since have been recorded in
   * recorded-invoices.json; that record is this invoice. `poRead`: the PO uploaded with the invoice, if any
   * (otherwise the PO is looked up among those keyed in data/).
   */
  async check(
    file: string,
    hash: string,
    read: ReadResult,
    seen: Seen,
    approved = false,
    poRead?: PoReadResult,
  ): Promise<InvoiceResult> {
    try {
      return await this.checkOrThrow(file, hash, read, seen, approved, poRead);
    } catch (error) {
      return reviewWithoutInvoice(file, read.readBy, read.model, `The checks failed: ${messageOf(error)}`);
    }
  }

  /** The checks, step by step. Throws when the data they need is broken (check() turns that into Review). */
  private async checkOrThrow(
    file: string,
    hash: string,
    read: ReadResult,
    seen: Seen,
    approved: boolean,
    poRead: PoReadResult | undefined,
  ): Promise<InvoiceResult> {
    const sameFile = seen.byHash.get(hash) ?? null;
    if (!read.invoice) return reviewWithoutInvoice(file, null, read.model, read.error ?? "Unknown error");

    const { invoice, problems } = normalizeInvoice(read.invoice);
    const supplier = await this.accounting.findSupplier(invoice);
    const { month, from: monthFrom } = monthOf(invoice);
    const uploaded = poRead ? uploadedPo(poRead) : null;
    // An uploaded PO that couldn't be read is no PO (poFoundBy null); check 2 says why.
    const { po, poFoundBy, poCandidates, sameMonthPos } = uploaded
      ? { po: uploaded.po, poFoundBy: uploaded.po ? ("uploaded" as const) : null, poCandidates: 0, sameMonthPos: [] }
      : await findKeyedPo(this.accounting, invoice, supplier, month);
    // Once a person approved the invoice, its record in recorded-invoices.json is this invoice, not an earlier copy.
    const alreadyRecorded =
      supplier && !approved ? await this.accounting.isAlreadyRecorded(supplier.id, invoice.invoiceNumber) : false;
    const invoiceKey = invoiceKeyOf(invoice, supplier);
    const poAlreadyBilledBy = await findPoAlreadyBilledBy(this.accounting, po, invoice.invoiceNumber, month, seen.byPo);

    const checks = this.checker.run(invoice, {
      supplier,
      po,
      alreadyRecorded,
      duplicateInBatch: sameFile ?? seen.byKey.get(invoiceKey) ?? null,
      readProblems: problems,
      poFoundBy,
      poCandidates,
      sameMonthPos,
      poAlreadyBilledBy,
      textract: read.textract ?? null,
      uploadedPo: uploaded ? { error: uploaded.error, problems: uploaded.problems } : undefined,
    });
    const lines = this.checker.compareLines(invoice, po);
    return {
      file,
      outcome: this.checker.outcome(checks),
      readBy: read.readBy,
      model: read.model,
      invoice,
      checks,
      error: null,
      context: { supplier, po, poFoundBy, month: { value: month, from: monthFrom }, lines },
      invoiceKey,
    };
  }

  /**
   * What an invoice holds for the duplicate check: its invoice key, and the PO it bills (a recurring PO: for its
   * month). Only a real invoice from the PO's own supplier bills a PO (a delivery order, a statement or a mistyped
   * PO number from another supplier don't).
   */
  claims(result: InvoiceResult): Claims {
    const context = result.context;
    const po = context?.po ?? null;
    const invoice = result.invoice;
    const isInvoice = invoice !== null && INVOICE_TYPES.includes(invoice.documentType);
    const billsPo = po !== null && isInvoice && isPoSupplier(po, invoice, context?.supplier ?? null);
    return { invoiceKey: result.invoiceKey, poKey: billsPo ? poBillingKey(po, context?.month.value ?? null) : null };
  }

  /** Remember an invoice, so later copies (and later invoices for the same PO, or PO and month) are caught. */
  remember(seen: Seen, file: string, hash: string, result: InvoiceResult | Claims): void {
    const claims = "file" in result ? this.claims(result) : result;
    if (!seen.byHash.has(hash)) seen.byHash.set(hash, file);
    if (claims.invoiceKey && !seen.byKey.has(claims.invoiceKey)) seen.byKey.set(claims.invoiceKey, file);
    if (claims.poKey && !seen.byPo.has(claims.poKey)) seen.byPo.set(claims.poKey, file);
  }
}

/** A stopwatch: the seconds since it was started, to one decimal (1234 ms → 1.2). */
function timer(): () => number {
  const started = performance.now();
  return () => Math.round((performance.now() - started) / 100) / 10;
}

/** Same supplier + invoice number = same invoice, e.g. "SUP-RENTOKIL|0021490975"; an unknown supplier goes by name. */
function invoiceKeyOf(invoice: StandardInvoice, supplier: SupplierRecord | null): string {
  return `${supplier?.id ?? normName(invoice.supplier.name)}|${normId(invoice.invoiceNumber)}`;
}

/** A Review result with nothing to show but the reason: the file couldn't be read, or the checks failed. */
function reviewWithoutInvoice(file: string, readBy: ReadBy | null, model: string | null, error: string): InvoiceResult {
  return { file, outcome: "REVIEW", readBy, model, invoice: null, checks: [], error, context: null, invoiceKey: null };
}

/** The text of anything thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
