import { bankAccounts, type SupplierRecord } from "../../accounting/accounting.source.js";
import type { StandardInvoice } from "../../invoice.schema.js";
import { D, knownAccount, sameId } from "../../normalize.js";
import { checkResult, type Finding } from "../findings.js";
import type { CheckContext, CheckResult } from "../types.js";

const NAME = "Supplier is real";

/** Check 6: supplier is real: known supplier, same bank account as on file, valid GST registration. */
export function supplierIsReal(invoice: StandardInvoice, context: CheckContext): CheckResult {
  const supplier = context.supplier;
  if (!supplier) {
    return { id: 6, name: NAME, status: "fail", details: [`"${invoice.supplier.name}" is not on our supplier list`] };
  }
  return checkResult(6, NAME, [
    uenMismatch(invoice, supplier),
    unknownBankAccount(invoice, supplier),
    gstProblem(invoice, supplier),
  ]);
}

/** The UEN on the invoice must be the one on file (when both have one). */
function uenMismatch(invoice: StandardInvoice, supplier: SupplierRecord): Finding | null {
  const uen = invoice.supplier.uen;
  if (!uen || !supplier.uen || sameId(uen, supplier.uen)) return null;
  return { status: "fail", text: `UEN on invoice (${uen}) differs from the one on file (${supplier.uen})` };
}

/** The bank account on the invoice must be one of those on file. */
function unknownBankAccount(invoice: StandardInvoice, supplier: SupplierRecord): Finding | null {
  const account = invoice.bank.accountNumber;
  const onFile = bankAccounts(supplier);
  if (!account || knownAccount(account, onFile)) return null;
  return {
    status: "fail",
    text:
      `Bank account on invoice (${account}) is NOT the one on file (${onFile.join(" or ")}). ` +
      "Confirm with the supplier using the phone number on file before paying.",
  };
}

/** Charging GST needs a GST registration, on file and on the invoice, and the two must be the same. */
function gstProblem(invoice: StandardInvoice, supplier: SupplierRecord): Finding | null {
  const onFile = supplier.gstRegNo;
  const onInvoice = invoice.supplier.gstRegNo;
  if (!D(invoice.tax).gt(0)) {
    if (!onFile) return null;
    return { status: "note", text: "Supplier is GST-registered but charged no GST. Check if it's zero-rated." };
  }
  if (!onFile) return { status: "fail", text: "Charges GST, but the supplier is not GST-registered on file" };
  if (!onInvoice) return { status: "fail", text: "Charges GST, but no GST registration no. on the invoice" };
  if (sameId(onInvoice, onFile)) return null;
  return { status: "fail", text: `GST reg. no. on invoice (${onInvoice}) differs from the one on file (${onFile})` };
}
