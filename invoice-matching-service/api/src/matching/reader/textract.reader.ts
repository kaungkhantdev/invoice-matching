import {
  AnalyzeExpenseCommand,
  TextractClient,
  type AnalyzeExpenseCommandOutput,
  type ExpenseField,
} from "@aws-sdk/client-textract";
import { config } from "../../config.js";
import { pageProblemOrThrow } from "./textract/errors.js";
import { pickFields } from "./textract/fields.js";
import { pageResult, type PageResult } from "./textract/page.js";

// pickFields lives in textract/fields.ts; exported here too, so imports from this file keep working.
export { pickFields };

/**
 * What Amazon Textract (AnalyzeExpense) found, kept with the invoice so check 0 can compare it with the AI.
 * A field is filled only when Textract found it with good confidence and one consistent value.
 * Anything unclear stays null and is simply not compared.
 */
export interface TextractRead {
  by: "textract";
  /** Pages Textract read. */
  pages: number;
  /** PDF pages beyond TEXTRACT_MAX_PAGES, not read by Textract. */
  skippedPages: number;
  fields: {
    invoiceNumber: string | null;
    poNumber: string | null;
    subtotal: string | null;
    tax: string | null;
    total: string | null;
    /** "AMOUNT_DUE" when no total was printed: it can differ from the total (deposit, balance b/f). */
    totalFrom: "TOTAL" | "AMOUNT_DUE" | null;
    gstRegNo: string | null;
    supplierName: string | null;
  };
  /** Set when Textract couldn't read this file (bad image, unsupported page…). The AI still reads it. */
  error: string | null;
}

/** `read` is kept; `text` (the OCR text, line by line) goes to the AI with the file. */
export interface TextractOutput {
  read: TextractRead;
  text: string | null;
}

const NO_FIELDS: TextractRead["fields"] = {
  invoiceNumber: null,
  poNumber: null,
  subtotal: null,
  tax: null,
  total: null,
  totalFrom: null,
  gstRegNo: null,
  supplierName: null,
};

/** A Textract result that only says what went wrong (nothing read). */
export function textractProblem(error: string, pages = 0, skippedPages = 0): TextractOutput {
  return { read: { by: "textract", pages, skippedPages, fields: NO_FIELDS, error }, text: null };
}

/** The one AWS call we make, so tests can pass a fake. */
type Send = (command: AnalyzeExpenseCommand) => Promise<AnalyzeExpenseCommandOutput>;

/**
 * Pages kept in memory, so a retry or "Read again" doesn't pay for a page twice. Big enough for a 700-invoice
 * month end at up to 5 pages each (a retry goes to the back of the queue). Each page is a few KB to ~20 KB.
 */
const PAGE_CACHE_SIZE = Math.max(4000, 800 * config.textract.maxPages);

/**
 * Amazon Textract: reads every page first. One AnalyzeExpense request per page gives both
 * the OCR text (for the AI) and the invoice fields (for check 0).
 */
export class TextractReader {
  private client: TextractClient | null = null;
  /** When the next request may be sent (a Date.now() time). */
  private nextSlot = 0;
  /** Finished or still-running page reads, by file fingerprint + page number. Failed reads are not kept. */
  private readonly pageCache = new Map<string, Promise<PageResult>>();

  /** `sendFn` and `requestsPerSecond` can be replaced in tests. */
  constructor(
    private readonly sendFn?: Send,
    private readonly requestsPerSecond: number = config.textract.tps,
  ) {}

  /**
   * `pages`: JPEG images (a photo, or the PDF's pages turned into images).
   * `skippedPages`: PDF pages not sent (over TEXTRACT_MAX_PAGES), so check 0 can say so.
   * `fileKey`: the file's fingerprint. Pages already read for it are reused, never paid for twice.
   * Throws RetryableError (busy) or Error (no login): pages read before that are kept for the next try.
   * A page Textract can't read is noted in `read.error`; the other pages are still read and used.
   */
  async read(pages: Buffer[], skippedPages = 0, fileKey: string | null = null): Promise<TextractOutput> {
    const totalPages = pages.length + skippedPages;
    const severalPages = totalPages > 1;
    const fields: ExpenseField[] = [];
    const text: string[] = [];
    const problems: string[] = [];
    for (const [i, page] of pages.entries()) {
      let result: PageResult;
      try {
        result = await this.readPage(page, fileKey === null ? null : `${fileKey}:${i}`);
      } catch (error) {
        const problem = pageProblemOrThrow(error);
        problems.push(severalPages ? `page ${i + 1}: ${problem}` : problem);
        if (severalPages) text.push(`--- Page ${i + 1} of ${totalPages}: Textract couldn't read this page ---`);
        continue;
      }
      fields.push(...result.fields);
      const pageText = result.lines.join("\n");
      text.push(severalPages ? `--- Page ${i + 1} of ${totalPages} ---\n${pageText}` : pageText);
    }

    const anyPageRead = problems.length < pages.length;
    if (skippedPages > 0 && anyPageRead) text.push(`(The last ${skippedPages} page(s) were not read by Textract.)`);
    const joined = anyPageRead ? text.join("\n\n").trim() : "";
    const error = problems.length ? problems.join("; ") : null;
    return {
      read: { by: "textract", pages: pages.length, skippedPages, fields: pickFields(fields), error },
      text: joined === "" ? null : joined,
    };
  }

  /** One page: from memory if this page of this file was read before (or is being read right now). */
  private readPage(page: Buffer, key: string | null): Promise<PageResult> {
    if (!key) return this.analyze(page);
    const known = this.pageCache.get(key);
    if (known) {
      // Used again: move it to the back, so the pages dropped first are the ones not used for longest.
      this.pageCache.delete(key);
      this.pageCache.set(key, known);
      return known;
    }
    const pending = this.analyze(page);
    this.pageCache.set(key, pending);
    // A failed read (busy, no login…) is forgotten, so the next try asks Textract again.
    pending.catch(() => {
      if (this.pageCache.get(key) === pending) this.pageCache.delete(key);
    });
    if (this.pageCache.size > PAGE_CACHE_SIZE) {
      const leastRecentlyUsed = this.pageCache.keys().next().value!;
      this.pageCache.delete(leastRecentlyUsed);
    }
    return pending;
  }

  /** One AnalyzeExpense request for one page image. */
  private async analyze(page: Buffer): Promise<PageResult> {
    const answer = await this.send(new AnalyzeExpenseCommand({ Document: { Bytes: page } }));
    return pageResult(answer);
  }

  /** Every request waits for its turn first; tests answer with `sendFn` instead of AWS. */
  private async send(command: AnalyzeExpenseCommand): Promise<AnalyzeExpenseCommandOutput> {
    await this.waitForSlot();
    if (this.sendFn) return this.sendFn(command);
    this.client ??= newClient();
    return this.client.send(command);
  }

  /**
   * Keep to the AWS quota (AnalyzeExpense in Singapore: 1 request per second by default).
   * When 700 invoices arrive at once, Textract requests wait their turn here instead of failing.
   */
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + 1000 / this.requestsPerSecond;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

/** The real AWS client, made on the first real request. */
function newClient(): TextractClient {
  return new TextractClient({
    region: config.textract.region,
    // Adaptive retries slow down by themselves when many invoices arrive at once.
    maxAttempts: 5,
    retryMode: "adaptive",
    // Never hang: a blocked network or a stalled request fails within seconds.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000, throwOnRequestTimeout: true },
  });
}
