import { config } from "../../../config.js";
import type { StandardInvoice } from "../../invoice.schema.js";
import { D } from "../../normalize.js";
import { checkResult, compare, type Finding } from "../findings.js";
import type { CheckResult } from "../types.js";

/** Check 1: qty × price = amount; lines = subtotal; subtotal + GST + fees − discounts = total; GST = 9%. */
export function mathAddsUp(invoice: StandardInvoice): CheckResult {
  const findings = lineAmounts(invoice);
  const linesSum = invoice.lines.reduce((sum, line) => sum.plus(line.amount), D(0));
  findings.push(compare("Subtotal", D(invoice.subtotal), linesSum));
  findings.push(...totalAndGst(invoice));
  return checkResult(1, "Math adds up", findings);
}

/** qty × unit price = amount, only when a unit price is printed (a monthly service charge has just an amount). */
function lineAmounts(invoice: StandardInvoice): (Finding | null)[] {
  return invoice.lines.map((line, i) => {
    if (line.unitPrice === null) return null;
    return compare(`Line ${i + 1} amount`, D(line.amount), D(line.quantity).times(line.unitPrice));
  });
}

/** subtotal + fees − discounts (+ GST, unless the prices include it) = total; and GST is charged at the GST rate. */
function totalAndGst(invoice: StandardInvoice): (Finding | null)[] {
  const rate = config.gstRate;
  const subtotal = D(invoice.subtotal);
  const tax = D(invoice.tax);
  const base = subtotal.plus(D(invoice.fees)).minus(D(invoice.discounts));
  const chargesGst = tax.gt(0);
  if (invoice.pricesIncludeTax) {
    // The GST is inside the total: GST = base × rate ÷ (1 + rate).
    return [
      compare("Total", D(invoice.total), base),
      chargesGst ? compare("GST", tax, base.times(rate).div(rate.plus(1))) : null,
    ];
  }
  return [
    compare("Total", D(invoice.total), base.plus(tax)),
    chargesGst ? compare(`GST (${rate.times(100)}%)`, tax, base.times(rate)) : null,
  ];
}
