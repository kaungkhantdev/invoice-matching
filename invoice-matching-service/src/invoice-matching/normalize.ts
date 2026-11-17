import { Decimal } from "decimal.js";
import type { StandardInvoice } from "./invoice.schema.js";

export const D = (v: string | number) => new Decimal(v);

/** Round to cents, half-up (how GST and invoice totals are normally rounded). */
export const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Show an amount with at least 2 decimals, keeping extra decimals if a unit price has them. */
export const fmt = (d: Decimal) => d.toFixed(Math.max(2, d.decimalPlaces()));

/** "S$1,234.50" → "1234.50", "(20.00)" → "-20.00", "" → "0". Returns null if it isn't a number. */
export function cleanAmount(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === "" || s === "-") return "0";
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[A-Za-z$€£¥\s,]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return (negative ? "-" : "") + s;
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** Uppercase letters and digits only, for comparing IDs ("PO 2026/0101" ≈ "po-2026-0101"). */
export const normId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Digits only, for comparing bank account numbers. */
export const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Clean what a reader returned so the checks can trust the format.
 * Anything that can't be cleaned is listed in `problems` (→ the invoice goes to review).
 */
export function normalizeInvoice(raw: StandardInvoice): { invoice: StandardInvoice; problems: string[] } {
  const problems: string[] = [];

  const amount = (label: string, value: string, absolute = false): string => {
    const cleaned = cleanAmount(value);
    if (cleaned === null) {
      problems.push(`${label} is not a number: "${value}"`);
      return "0";
    }
    return absolute ? D(cleaned).abs().toString() : cleaned;
  };

  const date = (label: string, value: string | null): string | null => {
    if (value == null || value.trim() === "") return null;
    const v = value.trim();
    if (!isIsoDate(v)) {
      problems.push(`${label} is not a valid date: "${value}"`);
      return null;
    }
    return v;
  };

  const currency = raw.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`Currency is not a 3-letter code: "${raw.currency}"`);

  const invoiceNumber = raw.invoiceNumber.trim();
  if (invoiceNumber === "") problems.push("Invoice number is missing");

  const lines = raw.lines.map((l, i) => ({
    description: l.description.trim(),
    quantity: amount(`Line ${i + 1} quantity`, l.quantity),
    unitPrice: amount(`Line ${i + 1} unit price`, l.unitPrice),
    amount: amount(`Line ${i + 1} amount`, l.amount),
  }));
  if (lines.length === 0) problems.push("No line items found");

  const trimOrNull = (s: string | null) => (s == null || s.trim() === "" ? null : s.trim());

  const subtotal = amount("Subtotal", raw.subtotal);
  const tax = amount("GST", raw.tax);
  const fees = amount("Fees", raw.fees);
  const discounts = amount("Discounts", raw.discounts, true);
  const total = amount("Total", raw.total);

  return {
    problems,
    invoice: {
      ...raw,
      pricesIncludeTax: pricesIncludeTaxFromNumbers(raw.pricesIncludeTax, subtotal, tax, fees, discounts, total),
      supplier: {
        name: raw.supplier.name.trim(),
        uen: trimOrNull(raw.supplier.uen),
        gstRegNo: trimOrNull(raw.supplier.gstRegNo),
        address: trimOrNull(raw.supplier.address),
      },
      bank: {
        accountHolder: trimOrNull(raw.bank.accountHolder),
        accountNumber: trimOrNull(raw.bank.accountNumber),
        swift: trimOrNull(raw.bank.swift),
      },
      invoiceNumber,
      invoiceDate: date("Invoice date", raw.invoiceDate),
      dueDate: date("Due date", raw.dueDate),
      poNumber: trimOrNull(raw.poNumber),
      currency,
      lines,
      subtotal,
      tax,
      fees,
      discounts,
      total,
    },
  };
}

/**
 * Whether line prices already include GST, worked out from the totals instead of trusting the reader:
 *   GST added on top:  subtotal + GST + fees − discounts = total
 *   GST included:      subtotal       + fees − discounts = total
 * If exactly one of these adds up, that's the answer. Otherwise keep what the reader said.
 */
export function pricesIncludeTaxFromNumbers(
  readerSaid: boolean,
  subtotal: string,
  tax: string,
  fees: string,
  discounts: string,
  total: string,
): boolean {
  if (D(tax).isZero()) return false;
  const close = (a: Decimal, b: Decimal) => a.minus(b).abs().lte("0.05");
  const base = D(subtotal).plus(fees).minus(discounts);
  const addedOnTop = close(base.plus(tax), D(total));
  const included = close(base, D(total));
  if (addedOnTop && !included) return false;
  if (included && !addedOnTop) return true;
  return readerSaid;
}
