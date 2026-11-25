import type { Decimal } from "decimal.js";
import { D } from "./amounts.js";

/** Totals this close still add up (rounding differences on the invoice). */
const TOTALS_CLOSE_WITHIN = "0.05";

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
  const nearlyEqual = (a: Decimal, b: Decimal) => a.minus(b).abs().lte(TOTALS_CLOSE_WITHIN);
  const base = D(subtotal).plus(fees).minus(discounts);
  const addedOnTop = nearlyEqual(base.plus(tax), D(total));
  const included = nearlyEqual(base, D(total));
  if (addedOnTop && !included) return false;
  if (included && !addedOnTop) return true;
  return readerSaid;
}
