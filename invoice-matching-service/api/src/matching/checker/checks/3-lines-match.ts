import { config } from "../../../config.js";
import type { PoLine, PurchaseOrder } from "../../accounting/accounting.source.js";
import { monthOf, type StandardInvoice } from "../../invoice.schema.js";
import { D, sameSite } from "../../normalize.js";
import { checkResult, type Finding } from "../findings.js";
import { compareLines } from "../lines.js";
import { allWordsIn, descriptionVariants, lineSimilarity } from "../similarity.js";
import type { CheckContext, CheckResult, LineComparison } from "../types.js";

type InvoiceLine = StandardInvoice["lines"][number];
type ServiceRecord = StandardInvoice["serviceRecords"][number];

const NAME = "Lines match PO";

/** Extra score for a line that holds every word of the item: it wins over a line that is only similar. */
const CONTAINED_BONUS = 0.5;

/** Check 3: lines match the PO: same price, not more than received / ordered, and the delivery is proven. */
export function linesMatch(invoice: StandardInvoice, context: CheckContext, matches: (PoLine | null)[]): CheckResult {
  if (!context.po) return { id: 3, name: NAME, status: "skip", details: ["No PO to compare with"] };
  const findings = compareLines(invoice, context.po, matches).flatMap((row) => lineProblems(row));
  findings.push(...serviceProof(invoice, context.po, matches));
  return checkResult(3, NAME, findings);
}

/** What is wrong with one line, in words: not on the PO, its price, or its quantity. */
function lineProblems(row: LineComparison): Finding[] {
  if (row.free) return [];
  const label = `Line ${row.line} "${row.description}"`;
  if (!row.po) return [{ status: "fail", text: `${label} is not on the PO` }];
  const findings: Finding[] = [];
  if (row.priceNote) findings.push({ status: row.priceStatus, text: `${label}: ${row.priceNote}` });
  if (row.qtyNote) findings.push({ status: "fail", text: `${label}: ${row.qtyNote}` });
  return findings;
}

/**
 * Services (PO lines without a received qty) are proven by the service record attached to the invoice:
 * same site, same month, signed by us. Items it says weren't done but are billed get a note.
 */
function serviceProof(invoice: StandardInvoice, po: PurchaseOrder, matches: (PoLine | null)[]): Finding[] {
  // Only when the invoice bills a service line (a goods-only invoice is proven by the received quantities).
  const billsAService = matches.some((poLine) => poLine !== null && poLine.receivedQty == null);
  if (!billsAService) return [];
  const records = invoice.serviceRecords;
  if (records.length === 0) {
    const text = "No signed service record (service report, card or delivery order) attached as proof";
    return [{ status: "fail", text }];
  }
  const month = serviceMonth(invoice, po);
  // A record may name the site ("SLC 1") or give its address: either the PO's or the invoice's site will do.
  const sites = [po.site, invoice.site].filter((site): site is string => Boolean(site));
  const findings: Finding[] = [];
  const signedInMonth = records.some((record) => record.signed && inMonth(record, month));
  if (!signedInMonth) {
    const text = month ? `No signed service record dated in ${month}` : "No signed service record";
    findings.push({ status: "fail", text });
  }
  for (const record of records) findings.push(...recordProblems(invoice, record, month, sites));
  return findings;
}

/** A month known only from the invoice date is a guess (billed in arrears): the PO's month is better then. */
function serviceMonth(invoice: StandardInvoice, po: PurchaseOrder): string | null {
  const known = monthOf(invoice);
  const preferred = known.from === "invoice date" ? po.period : known.month;
  return preferred ?? known.month ?? po.period ?? null;
}

/** What is wrong with one service record: another site, another month, not signed, or billed items not done. */
function recordProblems(
  invoice: StandardInvoice,
  record: ServiceRecord,
  month: string | null,
  sites: string[],
): Finding[] {
  const findings: Finding[] = [];
  const day = record.dates[0] ?? "undated";
  if (isOtherSite(record, sites)) {
    findings.push({ status: "fail", text: `The ${record.kind} of ${day} is for "${record.site}", not this site` });
  }
  if (!inMonth(record, month)) {
    findings.push({ status: "note", text: `The ${record.kind} of ${day} is not in ${month}` });
  } else if (!record.signed) {
    findings.push({ status: "note", text: `The ${record.kind} of ${day} is not signed` });
  }
  for (const notDoneItem of record.notDone) {
    const billed = billedLineFor(invoice, notDoneItem);
    if (!billed) continue;
    const text = `"${billed.description}" is billed, but the ${record.kind} of ${day} says not done: ${notDoneItem}`;
    findings.push({ status: "note", text });
  }
  return findings;
}

/** The record names a site, and it is neither the PO's nor the invoice's. */
function isOtherSite(record: ServiceRecord, sites: string[]): boolean {
  const recordSite = record.site;
  if (!sites.length || !recordSite) return false;
  return !sites.some((site) => sameSite(site, recordSite));
}

/** Dated in the month (any record counts when the month isn't known). */
function inMonth(record: ServiceRecord, month: string | null): boolean {
  return !month || record.dates.some((date) => date.startsWith(month));
}

/** The charged invoice line an item marked "not done" is for, if any. */
function billedLineFor(invoice: StandardInvoice, notDoneItem: string): InvoiceLine | null {
  // "HWSC EcoWash Pearl Creme -5L: No Stock": compare the item name, not the reason.
  const item = notDoneItem.split(":")[0].trim() || notDoneItem;
  // The best-matching charged line, not just the first similar one ("85 X 150 …" ≠ "60 X 85 …").
  let billed: InvoiceLine | null = null;
  let bestScore = 0;
  for (const line of invoice.lines) {
    if (!D(line.amount).gt(0)) continue;
    const score = itemScore(line, item);
    if (score > bestScore) {
      billed = line;
      bestScore = score;
    }
  }
  return billed;
}

/** How well an invoice line matches an item name: 0 when it doesn't match at all. */
function itemScore(line: InvoiceLine, item: string): number {
  const score = lineSimilarity(line, item);
  const contained = descriptionVariants(line.description, line.quantity).some((variant) => allWordsIn(item, variant));
  if (score < config.lineMatchMinScore && !contained) return 0;
  return contained ? score + CONTAINED_BONUS : score;
}
