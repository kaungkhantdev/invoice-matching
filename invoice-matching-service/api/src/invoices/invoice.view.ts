import { readFile } from "node:fs/promises";
import { bankAccounts, type SupplierRecord } from "../matching/accounting/accounting.source.js";
import type { StandardInvoice } from "../matching/invoice.schema.js";
import type { InvoiceResult } from "../matching/matching.service.js";
import { knownAccount, sameId } from "../matching/normalize.js";
import { excelToText } from "../matching/reader/file-prep.js";
import { pdfPageCount } from "../matching/reader/pdf.js";
import type { Entry } from "./invoice-store.service.js";

/**
 * What the API returns: a short row for the list, and the full detail for one invoice.
 * Everything the page shows is worked out here, so the page only displays it.
 */

/** Pictures the page shows through the preview JPEG. */
export const IMAGE_KINDS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".svg"]);
/** Files the page shows as text. */
const TEXT_KINDS = new Set([".xml", ".csv", ".txt", ".xlsx"]);
const MAX_PREVIEW_PAGES = 10;
const MAX_PREVIEW_CHARS = 60_000;

/** Files the page may show inline. Everything else (SVG, XML…) only downloads. */
export const INLINE_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** The short row shown in the list (one row of GET /api/invoices). */
export function toSummary(entry: Entry) {
  const result = entry.result;
  const invoice = result?.invoice ?? null;
  const done = entry.state === "DONE";
  return {
    id: entry.id,
    seq: entry.seq,
    file: entry.file,
    // Read, but the checks haven't finished yet: still "reading" for the page.
    state: done && !result ? ("READING" as const) : entry.state,
    outcome: done ? (result?.outcome ?? null) : null,
    supplier: invoice?.supplier.name ?? null,
    invoiceNumber: invoice?.invoiceNumber ?? null,
    /** The PO it was matched to: printed on the invoice, or found by supplier + site + month. */
    // `||`: an uploaded PO read without a number has "" (check 2 says so); show the invoice's, or nothing.
    poNumber: result?.context?.po?.poNumber || invoice?.poNumber || null,
    poFoundBy: result?.context?.poFoundBy ?? null,
    currency: invoice?.currency ?? null,
    total: invoice?.total ?? null,
    readBy: result?.readBy ?? null,
    model: result?.model ?? null,
    seconds: entry.read?.seconds ?? null,
    /** Checked against a PO uploaded with it (screenshots), not one keyed in data/. */
    withPo: Boolean(entry.po),
    attempts: entry.attempts,
    retryError: entry.retryError,
    problems: problemsOf(result),
    decision: entry.decision,
    /** Checked, sorted to Review, and nobody has approved or rejected it yet. */
    needsReview: done && result?.outcome === "REVIEW" && !entry.decision,
    updatedAt: entry.updatedAt,
  };
}

/** What went wrong, in words: the read error first, then the details of failed checks and notes. */
function problemsOf(result: InvoiceResult | null): string[] {
  if (!result) return [];
  const readError = result.error ? [`Could not read: ${result.error}`] : [];
  const flagged = result.checks.filter((check) => check.status === "fail" || check.status === "note");
  return [...readError, ...flagged.flatMap((check) => check.details)];
}

/**
 * One invoice in full, with what the page needs to preview the original file. `poFiles`: where the PO files
 * uploaded with it are kept (none for an invoice checked against data/).
 */
export async function toDetail(entry: Entry, file: string, poFiles: string[] = []) {
  const preview = await previewOf(entry.ext, file);
  return {
    ...toSummary(entry),
    addedAt: entry.addedAt,
    size: entry.size,
    result: entry.result,
    review: entry.state === "DONE" ? reviewOf(entry.result) : null,
    error: entry.read?.error ?? null,
    previewKind: preview.kind,
    previewText: preview.text,
    pages: preview.pages,
    po: entry.po ? await uploadedPoOf(entry.po, poFiles) : null,
  };
}

/** The PO uploaded with the invoice: its files (to view them) and how reading them went. */
async function uploadedPoOf(po: NonNullable<Entry["po"]>, paths: string[]) {
  const files = await Promise.all(
    po.files.map(async (file, i) => {
      const preview = await previewOf(file.ext, paths[i]);
      return { n: i + 1, file: file.file, previewKind: preview.kind, previewText: preview.text, pages: preview.pages };
    }),
  );
  return { files, error: po.read?.error ?? null, model: po.read?.model ?? null, seconds: po.read?.seconds ?? null };
}

type Preview = { kind: "image" | "pages" | "text" | "none"; text: string | null; pages: number };

/** How the page can preview the original file: PDF pages as images, a picture, the text, or nothing. */
async function previewOf(ext: string, file: string): Promise<Preview> {
  if (ext === ".pdf") {
    const pageCount = await pdfPageCount(await readFile(file)).catch(() => 0);
    return { kind: "pages", text: null, pages: Math.min(MAX_PREVIEW_PAGES, pageCount) };
  }
  if (IMAGE_KINDS.has(ext)) return { kind: "image", text: null, pages: 0 };
  const text = TEXT_KINDS.has(ext) ? await readAsText(ext, file) : null;
  return { kind: text === null ? "none" : "text", text, pages: 0 };
}

/** The file as text, cut short when very long; null when it can't be read. */
async function readAsText(ext: string, file: string): Promise<string | null> {
  try {
    const data = await readFile(file);
    const text = ext === ".xlsx" ? await excelToText(data) : data.toString("utf8");
    return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n…` : text;
  } catch {
    // e.g. a password-protected or broken spreadsheet: just no preview.
    return null;
  }
}

/** What was read, next to what we have on file, and the two counts of the match summary. */
export function reviewOf(result: InvoiceResult | null) {
  const invoice = result?.invoice;
  if (!result || !invoice) return null;
  const checks = result.checks.filter((check) => check.status !== "skip");
  // Only against a PO, and without the free 0.00 lines (they need no PO).
  const lines = result.context?.po ? result.context.lines.filter((line) => !line.free) : [];
  const matchedLines = lines.filter((line) => line.po && line.priceStatus !== "fail" && line.qtyStatus === "pass");
  return {
    /**
     * Red on the page when it differs from what we have on file. Check 6 decides pass/fail
     * (it compares the GST no. only when GST is charged).
     */
    onFile: onFileOf(invoice, result.context?.supplier ?? null),
    serviceProof: serviceProofText(invoice.serviceRecords),
    checksPassed: checks.filter((check) => check.status !== "fail").length,
    checks: checks.length,
    /** Lines whose price and quantity match the PO (the service proof is part of check 3, not of this count). */
    linesMatched: matchedLines.length,
    lines: lines.length,
  };
}

/** The supplier's UEN, GST no. and bank account as read, next to ours (nothing to compare with when unknown). */
function onFileOf(invoice: StandardInvoice, supplier: SupplierRecord | null) {
  const accounts = supplier ? bankAccounts(supplier) : [];
  const gstOnFile = supplier ? (supplier.gstRegNo ?? "not GST-registered") : null;
  const bankOnFile = supplier ? accounts.join(" or ") : null;
  const sameGst = (read: string) => (supplier?.gstRegNo ? sameId(read, supplier.gstRegNo) : false);
  return {
    uen: compared(invoice.supplier.uen, supplier?.uen ?? null, sameId),
    gstRegNo: compared(invoice.supplier.gstRegNo, gstOnFile, sameGst),
    bank: compared(invoice.bank.accountNumber, bankOnFile, (read) => knownAccount(read, accounts)),
  };
}

/** `differs` only when both values are there and not the same. */
function compared(read: string | null, onFile: string | null, same: (read: string, onFile: string) => boolean) {
  return { onFile, differs: read !== null && onFile !== null && !same(read, onFile) };
}

/** e.g. "3 records · 3 signed · 2026-10-16 to 2026-10-30 · not done: EcoWash" */
function serviceProofText(records: StandardInvoice["serviceRecords"]): string {
  if (!records.length) return "none attached";
  const signed = records.filter((record) => record.signed).length;
  const dates = records.flatMap((record) => record.dates).sort();
  const notDone = records.flatMap((record) => record.notDone);
  const parts = [`${records.length} record${records.length > 1 ? "s" : ""}`, `${signed} signed`];
  if (dates.length) parts.push(dateSpan(dates));
  if (notDone.length) parts.push(`not done: ${notDone.join("; ")}`);
  return parts.join(" · ");
}

/** "2026-10-16", or "2026-10-16 to 2026-10-30" for several (sorted) dates. */
function dateSpan(sortedDates: string[]): string {
  if (sortedDates.length === 1) return sortedDates[0];
  return `${sortedDates[0]} to ${sortedDates.at(-1)}`;
}
