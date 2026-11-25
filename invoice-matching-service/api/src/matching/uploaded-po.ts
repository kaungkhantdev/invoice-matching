import { Decimal } from "decimal.js";
import type { PoLine, PurchaseOrder } from "./accounting/accounting.source.js";
import { cleanAmount, D, fmt, round2 } from "./normalize.js";
import type { PoRead } from "./po.schema.js";

/** The PO uploaded with an invoice (screenshots of our system's PO page), ready for the checks. */
export interface UploadedPo {
  po: PurchaseOrder | null;
  /** Why nothing could be read (the files, Bedrock, …); null when it was read. */
  error: string | null;
  /** What doesn't add up on the PO as read: check 2 fails on each, because the comparison can't be trusted. */
  problems: string[];
}

/** The page rounds each item's total to cents: 3.333 × 8.00 = 26.664 shows as 26.66. */
const ROUNDING = D("0.01");
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The PO as read from its screenshots → the PurchaseOrder the checks compare the invoice with, and its problems. */
export function uploadedPo(read: { po: PoRead | null; error: string | null }): UploadedPo {
  const shown = read.po;
  if (!shown) return { po: null, error: read.error ?? "nothing was read", problems: [] };
  if (shown.documentType !== "purchase_order") {
    return { po: null, error: null, problems: ["the files don't show a purchase order"] };
  }
  const problems: string[] = [];
  const lines = shown.lines.flatMap((line, i) => poLine(line, i, problems));
  // Our PO page always shows these: one missing was cut off the screenshots, and its check couldn't be done.
  if (!shown.poNumber) problems.push("no PO number on it");
  if (!shown.supplierName) problems.push("the supplier isn't on the screenshots");
  if (!shown.status) problems.push("the status isn't on the screenshots");
  if (!shown.site) problems.push("the delivery site isn't on the screenshots");
  const recurring = shown.lines.some((line) => line.frequency);
  if (recurring && (!shown.startDate || !shown.endDate)) problems.push("the contract dates aren't on the screenshots");
  if (!shown.lines.length) problems.push("no items read");
  problems.push(...grandTotalProblem(shown, lines));
  for (const [label, date] of [["contract start", shown.startDate], ["contract end", shown.endDate]] as const) {
    if (date !== null && !DATE.test(date)) problems.push(`couldn't read the ${label} date ("${date}")`);
  }
  if (shown.uncertainFields.length) problems.push(`not clear on the screenshots: ${shown.uncertainFields.join(", ")}`);

  const po: PurchaseOrder = {
    poNumber: shown.poNumber ?? "",
    supplierName: shown.supplierName ?? undefined,
    currency: shown.currency,
    site: shown.site ?? undefined,
    validFrom: validDate(shown.startDate),
    validTo: validDate(shown.endDate),
    status: shown.status ?? undefined,
    lines,
  };
  return { po, error: null, problems };
}

/** One item row as a PO line; a row whose numbers can't be read is left out, with a problem. */
function poLine(line: PoRead["lines"][number], i: number, problems: string[]): PoLine[] {
  const label = `item ${i + 1} "${line.description}"`;
  const quantity = cleanAmount(line.quantity);
  const total = cleanAmount(line.total);
  const unitPrice = line.unitPrice === null ? null : cleanAmount(line.unitPrice);
  if (quantity === null || total === null || (line.unitPrice !== null && unitPrice === null)) {
    problems.push(`couldn't read the numbers of ${label}`);
    return [];
  }
  if (unitPrice !== null) {
    const product = round2(D(quantity).times(unitPrice));
    if (product.minus(total).abs().gt(ROUNDING)) {
      problems.push(`${label}: ${quantity} × ${unitPrice} = ${fmt(product)}, the PO shows ${total}`);
    }
  }
  return [
    {
      description: line.description,
      code: line.code ?? undefined,
      frequency: line.frequency ?? undefined,
      unitPrice: unitPrice ?? undefined,
      amount: total,
      orderedQty: quantity,
    },
  ];
}

/** The items must add up to the grand total (a row read twice from overlapping screenshots, or one missed). */
function grandTotalProblem(shown: PoRead, lines: PoLine[]): string[] {
  if (shown.grandTotal === null) return [];
  const grandTotal = cleanAmount(shown.grandTotal);
  if (grandTotal === null) return [`couldn't read the grand total ("${shown.grandTotal}")`];
  const sum = lines.reduce((total, line) => total.plus(line.amount!), new Decimal(0));
  if (sum.eq(grandTotal)) return [];
  return [`the items add up to ${fmt(sum)}, its grand total is ${fmt(D(grandTotal))}`];
}

/** A YYYY-MM-DD date, or nothing (an unreadable date is a problem, not a guess). */
function validDate(date: string | null): string | undefined {
  return date !== null && DATE.test(date) ? date : undefined;
}
