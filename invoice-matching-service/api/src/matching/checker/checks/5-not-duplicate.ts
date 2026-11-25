import { isRecurring } from "../../accounting/accounting.source.js";
import { monthOf, type StandardInvoice } from "../../invoice.schema.js";
import type { CheckContext, CheckResult, CheckStatus } from "../types.js";

/**
 * Check 5: not a duplicate: not recorded before, not twice in this batch, and its PO not already billed
 * (a recurring PO: not already billed for this month).
 */
export function notDuplicate(invoice: StandardInvoice, context: CheckContext): CheckResult {
  const details: string[] = [];
  if (context.alreadyRecorded) details.push(`Invoice ${invoice.invoiceNumber} from this supplier is already recorded`);
  if (context.duplicateInBatch) details.push(`Same invoice as ${context.duplicateInBatch} in this batch`);
  let status: CheckStatus = details.length ? "fail" : "pass";
  const po = context.po;
  if (context.poAlreadyBilledBy && po) {
    const month = po.period ?? (isRecurring(po) ? monthOf(invoice).month : null);
    const period = month ? ` (${month})` : "";
    details.push(`PO ${po.poNumber}${period} is already billed by ${context.poAlreadyBilledBy}`);
    // A service PO (lines without received qty) is billed once. A goods PO may be billed in parts: a note.
    const isServicePo = po.lines.some((line) => line.receivedQty == null);
    if (isServicePo) status = "fail";
    else if (status === "pass") status = "note";
  }
  return { id: 5, name: "Not a duplicate", status, details };
}
