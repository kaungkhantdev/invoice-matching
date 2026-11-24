import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AccountingSource, normName, type PurchaseOrder, type SupplierRecord } from "./accounting/accounting.source.js";
import { CheckerService, type CheckResult, type LineComparison, type Outcome, type PoFoundBy } from "./checker/checker.service.js";
import { config, type AiProvider } from "./config.js";
import { monthOf, type MonthFrom, type ReadBy, type StandardInvoice } from "./invoice.schema.js";
import { normalizeInvoice, normId } from "./normalize.js";
import { RetryableError } from "./reader/extractor.js";
import { ReaderService } from "./reader/reader.service.js";
import type { TextractRead } from "./reader/textract.reader.js";

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

/** Invoices seen before this one: file fingerprint → name, invoice key → name, PO → the first invoice billing it. */
export interface Seen {
  byHash: Map<string, string>;
  byKey: Map<string, string>;
  byPo: Map<string, string>;
}

export const emptySeen = (): Seen => ({ byHash: new Map(), byKey: new Map(), byPo: new Map() });

/** What an invoice holds for the duplicate check (kept while it is read again, so later copies stay flagged). */
export interface Claims {
  invoiceKey: string | null;
  poNumber: string | null;
}

/**
 * READ → MAP → MATCH → FLAG for one invoice. Used by the command line (BatchService) and the web UI.
 */
@Injectable()
export class MatchingService {
  constructor(
    private readonly reader: ReaderService,
    private readonly checker: CheckerService,
    private readonly accounting: AccountingSource,
  ) {}

  fingerprint(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
  }

  /** READ. Never throws: a file that can't be read becomes an error the checks turn into REVIEW. */
  async read(fileName: string, data: Buffer, provider?: AiProvider): Promise<ReadResult> {
    const started = performance.now();
    const seconds = () => Math.round((performance.now() - started) / 100) / 10;
    try {
      const r = await this.reader.read(fileName, data, provider);
      return {
        invoice: r.invoice,
        readBy: r.readBy,
        model: r.model,
        error: null,
        retryable: false,
        textract: r.textract,
        seconds: seconds(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { invoice: null, readBy: null, model: null, error: message, retryable: error instanceof RetryableError, seconds: seconds() };
    }
  }

  /** MAP + MATCH + FLAG. Fast (no AI), so it can be re-run any time, e.g. after the PO data changes. */
  async check(file: string, hash: string, read: ReadResult, seen: Seen): Promise<InvoiceResult> {
    const sameFile = seen.byHash.get(hash) ?? null;
    if (!read.invoice) {
      return {
        file,
        outcome: "REVIEW",
        readBy: null,
        model: read.model,
        invoice: null,
        checks: [],
        error: read.error ?? "Unknown error",
        context: null,
        invoiceKey: null,
      };
    }

    const { invoice, problems } = normalizeInvoice(read.invoice);
    const supplier = await this.accounting.findSupplier(invoice);
    // The PO our team keyed: by the PO number on the invoice; if there is none, by supplier + site + month.
    let po = invoice.poNumber ? await this.accounting.findPo(invoice.poNumber) : null;
    let poFoundBy: PoFoundBy = po ? "number" : null;
    let poCandidates = 0;
    let sameMonthPos: PurchaseOrder[] = [];
    const { month, from: monthFrom } = monthOf(invoice);
    if (!invoice.poNumber && supplier && month) {
      // The invoice's site first; if that finds nothing (e.g. only "ICFM-Siglap Centre" is printed), the address
      // on the signed service record attached to it.
      const sites = [invoice.site, ...invoice.serviceRecords.filter((r) => r.signed).map((r) => r.site)];
      let candidates: PurchaseOrder[] = [];
      for (const site of new Set(sites.filter((x): x is string => Boolean(x)))) {
        const found = await this.accounting.findPosFor(supplier.id, site, month);
        if (found.length) {
          candidates = found;
          break;
        }
      }
      poCandidates = candidates.length;
      if (candidates.length === 1) [po, poFoundBy] = [candidates[0], "site and month"];
      // None for this site: show the supplier's POs for the month, so a misread or mis-keyed site is easy to spot.
      else if (candidates.length === 0) sameMonthPos = await this.accounting.findPosFor(supplier.id, null, month);
    }
    const alreadyRecorded = supplier ? await this.accounting.isAlreadyRecorded(supplier.id, invoice.invoiceNumber) : false;
    const invoiceKey = `${supplier?.id ?? normName(invoice.supplier.name)}|${normId(invoice.invoiceNumber)}`;

    // A PO already billed by an earlier invoice in this batch, or by a recorded one.
    let poAlreadyBilledBy: string | null = null;
    if (po) {
      const inBatch = seen.byPo.get(normId(po.poNumber));
      const recorded = (await this.accounting.recordedForPo(po.poNumber)).filter((n) => normId(n) !== normId(invoice.invoiceNumber));
      poAlreadyBilledBy = inBatch ?? (recorded.length ? `recorded invoice ${recorded.join(", ")}` : null);
    }

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
      // Only while Textract is on (switching it off and re-checking drops old results), never for the local LLM.
      textract: config.textract.enabled && read.readBy !== "local" ? (read.textract ?? null) : null,
    });
    return {
      file,
      outcome: this.checker.outcome(checks),
      readBy: read.readBy,
      model: read.model,
      invoice,
      checks,
      error: null,
      context: { supplier, po, poFoundBy, month: { value: month, from: monthFrom }, lines: this.checker.compareLines(invoice, po) },
      invoiceKey,
    };
  }

  /**
   * What an invoice holds for the duplicate check: its invoice key, and the PO it bills. Only a real invoice from
   * the PO's own supplier bills a PO (a delivery order, a statement or a mistyped PO number from another supplier don't).
   */
  claims(result: InvoiceResult): Claims {
    const po = result.context?.po;
    const isInvoice = result.invoice !== null && ["tax_invoice", "invoice"].includes(result.invoice.documentType);
    const sameSupplier = po !== undefined && po !== null && result.context?.supplier?.id === po.supplierId;
    return { invoiceKey: result.invoiceKey, poNumber: po && isInvoice && sameSupplier ? po.poNumber : null };
  }

  /** Remember an invoice, so later copies (and later invoices for the same monthly PO) are caught. */
  remember(seen: Seen, file: string, hash: string, result: InvoiceResult | Claims): void {
    const c = "file" in result ? this.claims(result) : result;
    if (!seen.byHash.has(hash)) seen.byHash.set(hash, file);
    if (c.invoiceKey && !seen.byKey.has(c.invoiceKey)) seen.byKey.set(c.invoiceKey, file);
    if (c.poNumber && !seen.byPo.has(normId(c.poNumber))) seen.byPo.set(normId(c.poNumber), file);
  }
}
