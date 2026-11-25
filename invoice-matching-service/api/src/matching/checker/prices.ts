import type { Decimal } from "decimal.js";
import { config } from "../../config.js";
import type { PoLine } from "../accounting/accounting.source.js";
import type { StandardInvoice } from "../invoice.schema.js";
import { D } from "../normalize.js";

/** The invoice's prices include GST (and it charges GST), so the GST must come out before comparing with the PO. */
export function mustTakeOutGst(invoice: StandardInvoice): boolean {
  return invoice.pricesIncludeTax && D(invoice.tax).gt(0);
}

/** A unit price or amount before GST, so it can be compared with the PO. */
export function exTax(invoice: StandardInvoice, value: string): Decimal {
  const decimal = D(value);
  return mustTakeOutGst(invoice) ? decimal.div(config.gstRate.plus(1)) : decimal;
}

/**
 * What a PO line allows for this quantity: quantity × unit price, or its amount for the ordered quantity shared
 * pro rata (6 bins for 21.60 → 4 bins 14.40; the same charge split over two lines adds up to 21.60, not 43.20).
 * A recurring line (with a frequency) allows its monthly amount, shared by the invoice lines billing it
 * (`invoicedOnPoLine`: their quantity together). Its own quantity counts visits, not what the invoice counts
 * (the PO's 10.5 bi-monthly is the invoice's 21), so it isn't used.
 */
export function poAmount(poLine: PoLine, quantity: string, invoicedOnPoLine?: Decimal): Decimal | null {
  if (poLine.amount != null && poLine.frequency) {
    const shared = invoicedOnPoLine !== undefined && !invoicedOnPoLine.isZero();
    return shared ? D(poLine.amount).times(quantity).div(invoicedOnPoLine) : D(poLine.amount);
  }
  if (poLine.amount != null) {
    const ordered = D(poLine.orderedQty);
    return ordered.isZero() ? D(poLine.amount) : D(poLine.amount).times(quantity).div(ordered);
  }
  if (poLine.unitPrice != null) return D(quantity).times(poLine.unitPrice);
  return null;
}
