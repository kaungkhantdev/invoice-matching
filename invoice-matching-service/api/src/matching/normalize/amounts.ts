import { Decimal } from "decimal.js";

/** A Decimal: all money math uses it, never JS numbers. */
export const D = (value: string | number) => new Decimal(value);

/** Round to cents, half-up (how GST and invoice totals are normally rounded). */
export const round2 = (amount: Decimal) => amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Show an amount with at least 2 decimals, keeping extra decimals if a unit price has them. */
export const fmt = (amount: Decimal) => amount.toFixed(Math.max(2, amount.decimalPlaces()));

/** "S$1,234.50" → "1234.50", "(20.00)" → "-20.00", "" → "0". Returns null if it isn't a number. */
export function cleanAmount(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (text === "" || text === "-") return "0";

  let negative = false;
  // Accounting style: "(20.00)" is a negative amount.
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  // Drop currency codes and signs, spaces and thousands separators.
  text = text.replace(/[A-Za-z$€£¥\s,]/g, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  }

  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return (negative ? "-" : "") + text;
}
