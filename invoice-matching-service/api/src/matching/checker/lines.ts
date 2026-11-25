import { Decimal } from "decimal.js";
import { config } from "../../config.js";
import type { PoLine, PurchaseOrder } from "../accounting/accounting.source.js";
import type { StandardInvoice } from "../invoice.schema.js";
import { D, fmt, round2 } from "../normalize.js";
import { exTax, poAmount } from "./prices.js";
import { lineSimilarity } from "./similarity.js";
import type { LineComparison } from "./types.js";

type InvoiceLine = StandardInvoice["lines"][number];

/** The LineComparison columns that compare a line with the PO (the others come from the invoice alone). */
type PoColumns = Omit<
  LineComparison,
  "line" | "description" | "quantity" | "invoicePriceExTax" | "invoiceAmountExTax"
>;
type PriceColumns = Pick<LineComparison, "poAllowed" | "priceStatus" | "priceEffect" | "priceNote">;
type QuantityColumns = Pick<LineComparison, "qtyStatus" | "cap" | "capFrom" | "qtyNote">;

/** An ex-GST unit price keeps at least cents. */
const MIN_PRICE_DECIMALS = 2;

/**
 * Pair each invoice line with the most similar PO line. Free lines (0.00: loaned dispensers, included refills)
 * are left unpaired: "Sign Jumbo Roll Tissue" must not be counted against the PO's "JRT Jumbo Roll 600g".
 */
export function matchLines(invoice: StandardInvoice, po: PurchaseOrder | null): (PoLine | null)[] {
  if (!po) return invoice.lines.map(() => null);
  // One line on each side: they belong together, however differently they are worded.
  if (po.lines.length === 1 && invoice.lines.length === 1) return [po.lines[0]];
  return invoice.lines.map((line) => (D(line.amount).isZero() ? null : mostSimilarPoLine(line, po.lines)));
}

/** The PO line whose description is closest to the invoice line's, if it is close enough. */
function mostSimilarPoLine(line: InvoiceLine, poLines: PoLine[]): PoLine | null {
  let best: PoLine | null = null;
  let bestScore = 0;
  for (const poLine of poLines) {
    const score = lineSimilarity(line, poLine.description);
    if (score > bestScore) {
      best = poLine;
      bestScore = score;
    }
  }
  return bestScore >= config.lineMatchMinScore ? best : null;
}

/**
 * Each invoice line next to the PO line it was paired with: price and quantity, each with a status.
 * Check 3 and the review page both use this, so they always agree. `matches`: the pairing, if already made.
 */
export function compareLines(
  invoice: StandardInvoice,
  po: PurchaseOrder | null,
  matches = matchLines(invoice, po),
): LineComparison[] {
  // Several invoice lines can belong to the same PO line: compare their TOTAL with what was received.
  const invoicedPerPoLine = quantityPerPoLine(invoice, matches);
  return invoice.lines.map((line, i) => {
    const poLine = matches[i];
    const invoiceSide = invoiceColumns(invoice, line, i);
    if (!poLine) return { ...invoiceSide, ...notOnPo(line) };
    return { ...invoiceSide, ...comparedWithPo(invoice, line, poLine, invoicedPerPoLine.get(poLine)!) };
  });
}

/** How much the invoice bills on each PO line, all its lines together. */
export function quantityPerPoLine(invoice: StandardInvoice, matches: (PoLine | null)[]): Map<PoLine, Decimal> {
  const invoiced = new Map<PoLine, Decimal>();
  invoice.lines.forEach((line, i) => {
    const poLine = matches[i];
    if (poLine) invoiced.set(poLine, (invoiced.get(poLine) ?? D(0)).plus(line.quantity));
  });
  return invoiced;
}

/** The columns that come from the invoice alone: what it bills, before GST. */
function invoiceColumns(invoice: StandardInvoice, line: InvoiceLine, i: number) {
  const priceExTax = invoicePriceExTax(invoice, line);
  return {
    line: i + 1,
    description: line.description,
    quantity: line.quantity,
    invoicePriceExTax: priceExTax === null ? null : fmt(priceExTax),
    invoiceAmountExTax: fmt(round2(exTax(invoice, line.amount))),
  };
}

/** A line not on the PO: fine if it is free (a loaned dispenser, an included refill), else it fails. */
function notOnPo(line: InvoiceLine): PoColumns {
  const free = D(line.amount).isZero();
  const status = free ? "pass" : "fail";
  return {
    po: null,
    poAllowed: null,
    free,
    priceStatus: status,
    priceEffect: null,
    qtyStatus: status,
    invoicedOnPoLine: null,
    cap: null,
    capFrom: null,
    priceNote: null,
    qtyNote: null,
  };
}

/** A line paired with a PO line: its price and its quantity, each checked against the PO. */
function comparedWithPo(invoice: StandardInvoice, line: InvoiceLine, poLine: PoLine, invoiced: Decimal): PoColumns {
  const price = comparePrice(invoice, line, poLine, invoiced);
  const quantity = compareQuantity(line, poLine, invoiced);
  // One by one on purpose: this is LineComparison's JSON key order, which the page and saved results rely on.
  return {
    po: poSummary(poLine),
    poAllowed: price.poAllowed,
    free: false,
    priceStatus: price.priceStatus,
    priceEffect: price.priceEffect,
    qtyStatus: quantity.qtyStatus,
    invoicedOnPoLine: invoiced.toString(),
    cap: quantity.cap,
    capFrom: quantity.capFrom,
    priceNote: price.priceNote,
    qtyNote: quantity.qtyNote,
  };
}

/**
 * The line's price against the PO. It matches when its amount matches the PO, or its unit price does: a unit price
 * printed rounded, or GST-inclusive rounding, can put one of the two a few cents off. The rounding allowance
 * applies to what the difference costs on this line, not to the unit price: 0.20 too much on 100 boxes is 20.00.
 */
function comparePrice(invoice: StandardInvoice, line: InvoiceLine, poLine: PoLine, invoiced: Decimal): PriceColumns {
  const priceExTax = invoicePriceExTax(invoice, line);
  const amountExTax = round2(exTax(invoice, line.amount));
  const allowed = poAmount(poLine, line.quantity, invoiced);
  const byAmount = allowed === null ? null : amountExTax.minus(round2(allowed)).abs();
  const byPrice = unitPriceCost(line, poLine, priceExTax);
  const comparedByPrice = byPrice !== null && (byAmount === null || byPrice.lte(byAmount));
  const effect = comparedByPrice ? byPrice : byAmount;
  const priceStatus = priceStatusOf(effect);
  const priceEffect = effect === null || effect.isZero() ? null : fmt(round2(effect));
  const poAllowed = allowed === null ? null : fmt(round2(allowed));
  if (priceStatus === "pass") return { poAllowed, priceStatus, priceEffect, priceNote: null };
  if (poLine.amount == null && poLine.unitPrice == null) {
    return { poAllowed, priceStatus, priceEffect, priceNote: "The PO line has no price" };
  }
  const allows = poLine.frequency ? monthlyAllows(poLine, poAllowed!) : `PO allows ${poAllowed} for ${line.quantity}`;
  const priceNote = comparedByPrice
    ? `Price ${fmt(priceExTax!)}, PO says ${fmt(D(poLine.unitPrice!))} (${priceEffect} on ${line.quantity} units)`
    : `Amount ${fmt(amountExTax)}, ${allows} (difference ${priceEffect})`;
  return { poAllowed, priceStatus, priceEffect, priceNote };
}

/** "the PO charges 24.27 a month", or, shared by several invoice lines, "the PO allows 12.14 of its 24.27 a month". */
function monthlyAllows(poLine: PoLine, poAllowed: string): string {
  const monthly = fmt(round2(D(poLine.amount!)));
  return poAllowed === monthly ? `the PO charges ${monthly} a month` : `the PO allows ${poAllowed} of its ${monthly} a month`;
}

/**
 * The invoice unit price before GST. A price incl. GST gives an ex-GST price with many decimals: keep as many as
 * the printed price has (at least cents), so 0.124 stays 0.124 and 3.80 incl. 9% GST becomes 3.49.
 */
function invoicePriceExTax(invoice: StandardInvoice, line: InvoiceLine): Decimal | null {
  if (line.unitPrice === null) return null;
  const printedDecimals = (line.unitPrice.split(".")[1] ?? "").length; // "0.1000" → 4 (trailing zeros count)
  const decimals = Math.max(MIN_PRICE_DECIMALS, printedDecimals);
  return exTax(invoice, line.unitPrice).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
}

/** What the unit price difference costs on this line (difference × qty); null when it can't be priced per unit. */
function unitPriceCost(line: InvoiceLine, poLine: PoLine, priceExTax: Decimal | null): Decimal | null {
  // Only a PO line priced per unit (not by amount), and an invoice line with a unit price and a quantity.
  if (priceExTax === null || poLine.unitPrice == null || poLine.amount != null) return null;
  if (D(line.quantity).isZero()) return null;
  return round2(priceExTax.minus(poLine.unitPrice).abs().times(D(line.quantity).abs()));
}

/** No difference → pass; within the rounding allowance → note; more, or nothing to compare with → fail. */
function priceStatusOf(effect: Decimal | null): LineComparison["priceStatus"] {
  if (effect === null) return "fail";
  if (effect.isZero()) return "pass";
  return effect.lte(config.tolerance) ? "note" : "fail";
}

/**
 * Goods: no more than received. Services (no received qty on the PO): no more than ordered.
 * Recurring lines: no limit, because the PO counts visits and the invoice counts items (the amount is compared).
 */
function compareQuantity(line: InvoiceLine, poLine: PoLine, invoiced: Decimal): QuantityColumns {
  if (poLine.frequency) return { qtyStatus: "pass", cap: null, capFrom: null, qtyNote: null };
  const cap = poLine.receivedQty ?? poLine.orderedQty;
  const capFrom = poLine.receivedQty != null ? "received" : "ordered";
  if (!invoiced.gt(cap)) return { qtyStatus: "pass", cap, capFrom, qtyNote: null };
  const inTotal = invoiced.eq(line.quantity) ? "" : ` (${invoiced.toString()} in total)`;
  const limit = capFrom === "received" ? `only ${cap} received` : `the PO has ${cap}`;
  return { qtyStatus: "fail", cap, capFrom, qtyNote: `Invoiced ${line.quantity}${inTotal}, ${limit}` };
}

/** The PO line as the page shows it, prices formatted like the invoice's. */
function poSummary(poLine: PoLine): LineComparison["po"] {
  return {
    description: poLine.description,
    unitPrice: poLine.unitPrice == null ? null : fmt(D(poLine.unitPrice)),
    amount: poLine.amount == null ? null : fmt(round2(D(poLine.amount))),
    orderedQty: poLine.orderedQty,
    receivedQty: poLine.receivedQty ?? null,
    frequency: poLine.frequency ?? null,
  };
}
