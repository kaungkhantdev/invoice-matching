import type { ExpenseField } from "@aws-sdk/client-textract";
import { Decimal } from "decimal.js";
import { cleanAmount, normId } from "../../normalize.js";
import type { TextractRead } from "../textract.reader.js";

/** Textract's confidence is 0–100. Below this, a value is too unsure to compare with. */
const MIN_CONFIDENCE = 80;

/** Currency marks that may be printed next to an amount. */
const CURRENCY_MARKS = /S\$|US\$|SGD|USD/gi;

/** The fields check 0 compares, from all pages' fields: only confident values that the pages agree on. */
export function pickFields(fields: ExpenseField[]): TextractRead["fields"] {
  // "Amount due" only when no total was printed at all.
  const hasTotal = fields.some((field) => confident(field, "TOTAL"));
  const total = hasTotal ? amount(fields, "TOTAL") : amount(fields, "AMOUNT_DUE");

  return {
    invoiceNumber: id(fields, "INVOICE_RECEIPT_ID"),
    poNumber: id(fields, "PO_NUMBER"),
    subtotal: amount(fields, "SUBTOTAL"),
    tax: amount(fields, "TAX"),
    total,
    totalFrom: totalFrom(total, hasTotal),
    gstRegNo: id(fields, "VENDOR_GST_NUMBER"),
    supplierName: single(values(fields, "VENDOR_NAME"), (value) => value.toLowerCase()),
  };
}

/** Where the total came from: "AMOUNT_DUE" only when no total was printed. */
function totalFrom(total: string | null, hasTotal: boolean): TextractRead["fields"]["totalFrom"] {
  if (total === null) return null;
  return hasTotal ? "TOTAL" : "AMOUNT_DUE";
}

/** An ID (invoice no., PO, GST no.): "PO 2026 0103" and "PO-2026-0103" count as the same value. */
function id(fields: ExpenseField[], type: string): string | null {
  return single(values(fields, type), normId);
}

/** An amount, cleaned ("S$ 1,035.50" → "1035.50"): "260" and "260.00" count as the same value. */
function amount(fields: ExpenseField[], type: string): string | null {
  const cleaned = values(fields, type)
    .filter(looksLikeMoney)
    .map((value) => cleanAmount(value))
    .filter((value): value is string => value !== null);
  return single(cleaned, (value) => new Decimal(value).toFixed(2));
}

/** Every confident, non-empty value of one field type, as printed. */
function values(fields: ExpenseField[], type: string): string[] {
  return fields
    .filter((field) => confident(field, type))
    .map((field) => (field.ValueDetection?.Text ?? "").trim())
    .filter((value) => value !== "");
}

/** The one value a field has across all pages, or null if it's missing or the pages disagree. */
function single(found: string[], key: (value: string) => string): string | null {
  const distinct = new Map<string, string>();
  for (const value of found) distinct.set(key(value), value);
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

/** Sure it IS this kind of field (Type) and sure of the characters (Value). */
function confident(field: ExpenseField, type: string): boolean {
  const sureOfType = (field.Type?.Confidence ?? 0) >= MIN_CONFIDENCE;
  const sureOfValue = (field.ValueDetection?.Confidence ?? 0) >= MIN_CONFIDENCE;
  return field.Type?.Text === type && sureOfType && sureOfValue;
}

/** An amount as printed: digits, separators, a currency mark. Anything with other letters is not money. */
function looksLikeMoney(value: string): boolean {
  return !/[A-Za-z]/.test(value.replace(CURRENCY_MARKS, ""));
}
