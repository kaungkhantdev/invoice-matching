import type { Decimal } from "decimal.js";
import { INVOICE_TYPES, type StandardInvoice } from "../../invoice.schema.js";
import { D, fmt, round2, sameId } from "../../normalize.js";
import type { TextractRead } from "../../reader/textract.reader.js";
import { worst, type Finding } from "../findings.js";
import type { CheckContext, CheckResult, CheckStatus } from "../types.js";

/** Check 0: did we read the document clearly, and is it really an invoice? */
export function readClearly(invoice: StandardInvoice, context: CheckContext): CheckResult {
  const findings: Finding[] = context.readProblems.map((text) => ({ status: "fail", text }));
  findings.push(...documentProblems(invoice));
  const textract = compareTextract(invoice, context.textract ?? null);
  findings.push(...textract.findings);
  const status = worst(findings);
  // The problems first; and unless something failed, also what Textract confirmed.
  const details = findings.map((finding) => finding.text);
  const showAgreed = status !== "fail" && textract.agreed.length > 0;
  if (showAgreed) details.push(`Textract agrees on ${textract.agreed.join(", ")}`);
  return { id: 0, name: "Read clearly", status, details };
}

/** Not an invoice, fields the reader wasn't sure of, or more than one invoice in the file. */
function documentProblems(invoice: StandardInvoice): Finding[] {
  const findings: Finding[] = [];
  if (!INVOICE_TYPES.includes(invoice.documentType)) {
    findings.push({ status: "fail", text: `This is a ${invoice.documentType.replace("_", " ")}, not an invoice` });
  }
  if (invoice.uncertainFields.length > 0) {
    findings.push({ status: "fail", text: `Reader wasn't sure about: ${invoice.uncertainFields.join(", ")}` });
  }
  const others = invoice.otherInvoicesInFile;
  if (others.length > 0) {
    findings.push({
      status: "fail",
      text:
        `This file holds ${others.length} more invoice(s) (${others.join(", ")}): ` +
        `only ${invoice.invoiceNumber} was read. Split the file, one invoice per file.`,
    });
  }
  return findings;
}

/**
 * Textract (OCR) and the AI must agree on the key fields they both found. Textract's fields come from its
 * own invoice model, separate from the AI's answer, so a misread number shows up here.
 * A field only one of them found isn't compared. Returns the fields they agreed on, and the differences.
 */
function compareTextract(invoice: StandardInvoice, textract: TextractRead | null) {
  const agreed: string[] = [];
  const findings: Finding[] = [];
  if (!textract) return { agreed, findings };
  findings.push(...textractGaps(textract));
  const fields = textract.fields;

  /** Agreed when any of the AI's values is the one Textract read. */
  const compareId = (label: string, aiValues: (string | null)[], textractValue: string | null) => {
    const known = aiValues.filter((value): value is string => Boolean(value));
    if (!known.length || !textractValue) return;
    const text = `${label}: the AI read "${known[0]}", Textract read "${textractValue}"`;
    if (known.some((value) => sameId(value, textractValue))) agreed.push(label);
    else findings.push({ status: "fail", text });
  };
  /** `accepted`: every value the AI's own numbers allow (printed forms differ between suppliers). */
  const compareAmount = (label: string, accepted: Decimal[], textractValue: string | null, onMismatch: CheckStatus) => {
    if (textractValue === null) return;
    const text = `${label}: the AI read ${fmt(round2(accepted[0]))}, Textract read ${textractValue}`;
    if (accepted.some((amount) => round2(amount).eq(round2(D(textractValue))))) agreed.push(label);
    else findings.push({ status: onMismatch, text });
  };

  compareId("invoice no.", [invoice.invoiceNumber], fields.invoiceNumber);
  compareId("PO", [invoice.poNumber], fields.poNumber);
  // Many Singapore invoices print the UEN as the GST number: either one counts.
  compareId("GST reg. no.", [invoice.supplier.gstRegNo, invoice.supplier.uen], fields.gstRegNo);
  compareAmount("subtotal", printedSubtotals(invoice), fields.subtotal, "fail");
  compareAmount("GST", [D(invoice.tax)], fields.tax, "fail");
  // "Amount due" can differ from the total for good reasons (deposit paid, balance brought forward).
  const isAmountDue = fields.totalFrom === "AMOUNT_DUE";
  compareAmount(isAmountDue ? "amount due" : "total", [D(invoice.total)], fields.total, isAmountDue ? "note" : "fail");
  return { agreed, findings };
}

/** A page Textract couldn't read: say so, and still compare whatever it found on the other pages. */
function textractGaps(textract: TextractRead): Finding[] {
  const findings: Finding[] = [];
  if (textract.error) {
    const text = `Textract couldn't read all of it, so the AI read that part alone: ${textract.error}`;
    findings.push({ status: "note", text });
  }
  if (textract.skippedPages > 0) {
    const allPages = textract.pages + textract.skippedPages;
    const text = `Textract read only the first ${textract.pages} of ${allPages} pages (TEXTRACT_MAX_PAGES)`;
    findings.push({ status: "note", text });
  }
  return findings;
}

/** A printed "Sub-total" may come before or after discounts and fees, and with or without GST. */
function printedSubtotals(invoice: StandardInvoice): Decimal[] {
  const subtotal = D(invoice.subtotal);
  const afterAdjustments = subtotal.plus(invoice.fees).minus(invoice.discounts);
  if (!invoice.pricesIncludeTax) return [subtotal, afterAdjustments];
  return [subtotal, afterAdjustments, subtotal.minus(invoice.tax), afterAdjustments.minus(invoice.tax)];
}
