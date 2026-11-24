import {
  AnalyzeExpenseCommand,
  TextractClient,
  type AnalyzeExpenseCommandOutput,
  type ExpenseField,
} from "@aws-sdk/client-textract";
import { Decimal } from "decimal.js";
import { config } from "../config.js";
import { cleanAmount, normId } from "../normalize.js";
import { RetryableError } from "./extractor.js";
import { isNetworkProblem, noLoginAtAll } from "./network.js";

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

type Send = (command: AnalyzeExpenseCommand) => Promise<AnalyzeExpenseCommandOutput>;

/** Textract's confidence is 0–100. Below this, a value is too unsure to compare with. */
const MIN_CONFIDENCE = 80;

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

const TEMPORARY = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "InternalServerError",
  "ServiceUnavailableException",
  "TimeoutError",
  "RequestTimeout",
]);
/** Getting the login failed (on this machine, before AWS was asked). */
const GETTING_LOGIN = new Set(["CredentialsProviderError", "TokenProviderError"]);
/** AWS itself rejected the login. */
const LOGIN_REJECTED = new Set(["UnrecognizedClientException", "InvalidSignatureException", "ExpiredTokenException"]);
const BAD_PAGE = new Set(["UnsupportedDocumentException", "BadDocumentException", "DocumentTooLargeException", "InvalidParameterException"]);

/**
 * Sort a Textract error into what to do:
 *   a page problem  → returned as text: the AI still reads the file, check 0 gets a note
 *   busy / network  → RetryableError: the queue tries the invoice again later
 *   login / access  → Error: the invoice goes to review with the fix in plain words
 */
function sortError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode ?? 0;
  const markedRetryable = Boolean((error as { $retryable?: unknown } | null)?.$retryable);
  if (BAD_PAGE.has(name)) return name === "DocumentTooLargeException" ? "too large for Textract" : `Textract couldn't read it (${name})`;
  // Network down, even while refreshing an SSO login: temporary. (Checked before the login errors on purpose.)
  if (TEMPORARY.has(name) || isNetworkProblem(error) || markedRetryable || status >= 500) {
    throw new RetryableError(`Textract (${config.textract.region}) busy or unreachable: ${name || code || "error"}: ${message}`);
  }
  // Getting the login failed: tried again (it may only be offline), then Review with what to do.
  if (GETTING_LOGIN.has(name) && noLoginAtAll(message)) {
    throw new RetryableError(`Textract: no AWS login found on this machine (run "aws configure" or "aws sso login"; or TEXTRACT=off to try without AWS): ${message}`);
  }
  if (GETTING_LOGIN.has(name)) {
    throw new RetryableError(`Textract: couldn't get the AWS login (network down, or the SSO session ended: run "aws sso login"): ${message}`);
  }
  if (LOGIN_REJECTED.has(name)) {
    throw new Error(`Textract: AWS rejected the login (expired? run "aws sso login"): ${message}`);
  }
  if (name === "AccessDeniedException") throw new Error(`Textract: this AWS login may not use textract:AnalyzeExpense: ${message}`);
  throw new Error(`Textract error ${name || String(code ?? "")}: ${message}`);
}

/** A Textract result that only says what went wrong (nothing read). */
export function textractProblem(error: string, pages = 0, skippedPages = 0): TextractOutput {
  return { read: { by: "textract", pages, skippedPages, fields: NO_FIELDS, error }, text: null };
}

/** The one value a field has across all pages, or null if it's missing or the pages disagree. */
function single(values: string[], key: (v: string) => string): string | null {
  const distinct = new Map<string, string>();
  for (const v of values) distinct.set(key(v), v);
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

/** Sure it IS this kind of field (Type) and sure of the characters (Value). */
const confident = (f: ExpenseField, type: string) =>
  f.Type?.Text === type &&
  (f.Type?.Confidence ?? 0) >= MIN_CONFIDENCE &&
  (f.ValueDetection?.Confidence ?? 0) >= MIN_CONFIDENCE;

/** An amount as printed: digits, separators, a currency mark. Anything with other letters is not money. */
const looksLikeMoney = (v: string) => !/[A-Za-z]/.test(v.replace(/S\$|US\$|SGD|USD/gi, ""));

export function pickFields(fields: ExpenseField[]): TextractRead["fields"] {
  const values = (type: string) =>
    fields
      .filter((f) => confident(f, type))
      .map((f) => (f.ValueDetection?.Text ?? "").trim())
      .filter((v) => v !== "");
  const id = (type: string) => single(values(type), normId);
  const amount = (type: string) => {
    const cleaned = values(type)
      .filter(looksLikeMoney)
      .map((v) => cleanAmount(v))
      .filter((v): v is string => v !== null);
    return single(cleaned, (v) => new Decimal(v).toFixed(2));
  };
  // "Amount due" only when no total was printed at all.
  const hasTotal = fields.some((f) => confident(f, "TOTAL"));
  const total = hasTotal ? amount("TOTAL") : amount("AMOUNT_DUE");

  return {
    invoiceNumber: id("INVOICE_RECEIPT_ID"),
    poNumber: id("PO_NUMBER"),
    subtotal: amount("SUBTOTAL"),
    tax: amount("TAX"),
    total,
    totalFrom: total === null ? null : hasTotal ? "TOTAL" : "AMOUNT_DUE",
    gstRegNo: id("VENDOR_GST_NUMBER"),
    supplierName: single(values("VENDOR_NAME"), (v) => v.toLowerCase()),
  };
}

/** What we keep of one page's AnalyzeExpense answer: its fields (only what pickFields uses) and its text lines. */
type PageResult = { fields: ExpenseField[]; lines: string[] };

/**
 * Pages kept in memory, so a retry or "Read again" doesn't pay for a page twice. Big enough for a 700-invoice
 * month end at up to 5 pages each (a retry goes to the back of the queue). Each page is a few KB to ~20 KB.
 */
const PAGE_CACHE_SIZE = Math.max(4000, 800 * config.textract.maxPages);

/** The page's text lines, in reading order (a page can hold more than one expense document). */
function pageLines(out: AnalyzeExpenseCommandOutput): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const doc of out.ExpenseDocuments ?? []) {
    for (const block of doc.Blocks ?? []) {
      if (block.BlockType !== "LINE" || !block.Text) continue;
      if (block.Id && seen.has(block.Id)) continue;
      if (block.Id) seen.add(block.Id);
      lines.push(block.Text);
    }
  }
  return lines;
}

/**
 * Amazon Textract (TEXTRACT=on): reads every page first. One AnalyzeExpense request per page gives both
 * the OCR text (for the AI) and the invoice fields (for check 0).
 */
export class TextractReader {
  private client: TextractClient | null = null;
  private nextSlot = 0;
  /** Finished or still-running page reads, by file fingerprint + page number. Failed reads are not kept. */
  private readonly pageCache = new Map<string, Promise<PageResult>>();

  /** `sendFn` and `tps` can be replaced in tests. */
  constructor(
    private readonly sendFn?: Send,
    private readonly tps: number = config.textract.tps,
  ) {}

  /**
   * Keep to the AWS quota (AnalyzeExpense in Singapore: 1 request per second by default).
   * When 700 invoices arrive at once, Textract requests wait their turn here instead of failing.
   */
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + 1000 / this.tps;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }

  private async send(command: AnalyzeExpenseCommand): Promise<AnalyzeExpenseCommandOutput> {
    await this.waitForSlot();
    if (this.sendFn) return this.sendFn(command);
    this.client ??= new TextractClient({
      region: config.textract.region,
      // Adaptive retries slow down by themselves when many invoices arrive at once.
      maxAttempts: 5,
      retryMode: "adaptive",
      // Never hang: a blocked network or a stalled request fails within seconds.
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000, throwOnRequestTimeout: true },
    });
    return this.client.send(command);
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
    if (this.pageCache.size > PAGE_CACHE_SIZE) this.pageCache.delete(this.pageCache.keys().next().value!);
    return pending;
  }

  private async analyze(page: Buffer): Promise<PageResult> {
    const out = await this.send(new AnalyzeExpenseCommand({ Document: { Bytes: page } }));
    const fields = (out.ExpenseDocuments ?? [])
      .flatMap((doc) => doc.SummaryFields ?? [])
      .map((f) => ({
        Type: { Text: f.Type?.Text, Confidence: f.Type?.Confidence },
        ValueDetection: { Text: f.ValueDetection?.Text, Confidence: f.ValueDetection?.Confidence },
      }));
    return { fields, lines: pageLines(out) };
  }

  /**
   * `pages`: JPEG images (a photo, or the PDF's pages turned into images).
   * `skippedPages`: PDF pages not sent (over TEXTRACT_MAX_PAGES), so check 0 can say so.
   * `fileKey`: the file's fingerprint. Pages already read for it are reused, never paid for twice.
   * Throws RetryableError (busy) or Error (no login): pages read before that are kept for the next try.
   * A page Textract can't read is noted in `read.error`; the other pages are still read and used.
   */
  async read(pages: Buffer[], skippedPages = 0, fileKey: string | null = null): Promise<TextractOutput> {
    const fields: ExpenseField[] = [];
    const text: string[] = [];
    const problems: string[] = [];
    const total = pages.length + skippedPages;
    for (const [i, page] of pages.entries()) {
      let result: PageResult;
      try {
        result = await this.readPage(page, fileKey === null ? null : `${fileKey}:${i}`);
      } catch (error) {
        const problem = sortError(error); // throws unless it's a problem with this page
        problems.push(total > 1 ? `page ${i + 1}: ${problem}` : problem);
        if (total > 1) text.push(`--- Page ${i + 1} of ${total}: Textract couldn't read this page ---`);
        continue;
      }
      fields.push(...result.fields);
      text.push(total > 1 ? `--- Page ${i + 1} of ${total} ---\n${result.lines.join("\n")}` : result.lines.join("\n"));
    }
    const anyRead = problems.length < pages.length;
    if (skippedPages > 0 && anyRead) text.push(`(The last ${skippedPages} page(s) were not read by Textract.)`);
    const joined = anyRead ? text.join("\n\n").trim() : "";
    return {
      read: { by: "textract", pages: pages.length, skippedPages, fields: pickFields(fields), error: problems.length ? problems.join("; ") : null },
      text: joined === "" ? null : joined,
    };
  }
}
