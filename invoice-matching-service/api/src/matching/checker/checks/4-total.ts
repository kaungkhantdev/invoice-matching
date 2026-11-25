import type { Decimal } from "decimal.js";
import { config } from "../../../config.js";
import type { PoLine } from "../../accounting/accounting.source.js";
import type { StandardInvoice } from "../../invoice.schema.js";
import { D, fmt, round2 } from "../../normalize.js";
import { checkResult, compare, type Finding } from "../findings.js";
import { quantityPerPoLine } from "../lines.js";
import { mustTakeOutGst, poAmount } from "../prices.js";
import type { CheckContext, CheckResult } from "../types.js";

const NAME = "Total matches PO";

/** Check 4: the invoice subtotal = invoiced quantities × PO prices. */
export function totalMatchesPo(
  invoice: StandardInvoice,
  context: CheckContext,
  matches: (PoLine | null)[],
): CheckResult {
  if (!context.po) return { id: 4, name: NAME, status: "skip", details: ["No PO to compare with"] };
  const findings: (Finding | null)[] = feesNotOnPo(invoice);
  // Free lines (0.00) don't need to be on the PO.
  const someLineNotOnPo = matches.some((poLine, i) => poLine === null && !D(invoice.lines[i].amount).isZero());
  if (someLineNotOnPo) {
    findings.push({ status: "skip", text: "Some lines are not on the PO" });
    return checkResult(4, NAME, findings, "skip");
  }
  // A recurring PO line's monthly amount is shared by the invoice lines billing it, so it counts once.
  const invoicedPerPoLine = quantityPerPoLine(invoice, matches);
  const allowed = invoice.lines.map((line, i) => {
    const poLine = matches[i];
    return poLine ? poAmount(poLine, line.quantity, invoicedPerPoLine.get(poLine)) : D(0);
  });
  if (allowed.some((amount) => amount === null)) {
    findings.push({ status: "skip", text: "Some PO lines have no price" });
    return checkResult(4, NAME, findings, "skip");
  }
  const expected = allowed.reduce<Decimal>((sum, amount) => sum.plus(amount!), D(0));
  findings.push(compare("Subtotal at PO prices", subtotalExTax(invoice), expected));
  return checkResult(4, NAME, findings);
}

/** Extra charges (delivery, surcharge…) are never on the PO: a person must agree to them. */
function feesNotOnPo(invoice: StandardInvoice): Finding[] {
  const fees = D(invoice.fees);
  if (!fees.gt(0)) return [];
  return [{ status: fees.lte(config.tolerance) ? "note" : "fail", text: `Fees of ${fmt(fees)} are not on the PO` }];
}

/** Same conversion as the unit prices: GST-inclusive amounts ÷ (1 + rate). */
function subtotalExTax(invoice: StandardInvoice): Decimal {
  if (!mustTakeOutGst(invoice)) return D(invoice.subtotal);
  return round2(D(invoice.subtotal).div(config.gstRate.plus(1)));
}
