import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AccountingSource, normName, type PurchaseOrder, type SupplierRecord } from "./accounting/accounting.source.js";
import { CheckerService, type CheckResult, type LineComparison, type Outcome } from "./checker/checker.service.js";
import type { AiProvider } from "./config.js";
import type { ReadBy, StandardInvoice } from "./invoice.schema.js";
import { normalizeInvoice, normId } from "./normalize.js";
import { RetryableError } from "./reader/extractor.js";
import { ReaderService } from "./reader/reader.service.js";

/** The slow part (AI), kept so the checks can be re-run later without reading the file again. */
export interface ReadResult {
  invoice: StandardInvoice | null;
  readBy: ReadBy | null;
  model: string | null;
  error: string | null;
  /** True for temporary problems (rate limit, server busy/down, timeout): worth trying again later. */
  retryable: boolean;
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
  /** What the invoice was compared with: our supplier record, the PO, and line by line. */
  context: { supplier: SupplierRecord | null; po: PurchaseOrder | null; lines: LineComparison[] } | null;
  /** Same supplier + invoice number = same invoice (for the duplicate check). */
  invoiceKey: string | null;
}

/** Invoices seen before this one: file fingerprint → name, invoice key → name. */
export interface Seen {
  byHash: Map<string, string>;
  byKey: Map<string, string>;
}

export const emptySeen = (): Seen => ({ byHash: new Map(), byKey: new Map() });

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
      return { invoice: r.invoice, readBy: r.readBy, model: r.model, error: null, retryable: false, seconds: seconds() };
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
    const po = invoice.poNumber ? await this.accounting.findPo(invoice.poNumber) : null;
    const alreadyRecorded = supplier ? await this.accounting.isAlreadyRecorded(supplier.id, invoice.invoiceNumber) : false;
    const invoiceKey = `${supplier?.id ?? normName(invoice.supplier.name)}|${normId(invoice.invoiceNumber)}`;

    const checks = this.checker.run(invoice, {
      supplier,
      po,
      alreadyRecorded,
      duplicateInBatch: sameFile ?? seen.byKey.get(invoiceKey) ?? null,
      readProblems: problems,
    });
    return {
      file,
      outcome: this.checker.outcome(checks),
      readBy: read.readBy,
      model: read.model,
      invoice,
      checks,
      error: null,
      context: { supplier, po, lines: this.checker.compareLines(invoice, po) },
      invoiceKey,
    };
  }

  /** Remember an invoice, so later copies are caught as duplicates. */
  remember(seen: Seen, file: string, hash: string, result: InvoiceResult): void {
    if (!seen.byHash.has(hash)) seen.byHash.set(hash, file);
    if (result.invoiceKey && !seen.byKey.has(result.invoiceKey)) seen.byKey.set(result.invoiceKey, file);
  }
}
