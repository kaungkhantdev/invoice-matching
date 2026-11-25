import { MONTH_LENGTH, type StandardInvoice } from "../invoice.schema.js";
import { cleanAmount, D } from "./amounts.js";
import { pricesIncludeTaxFromNumbers } from "./tax.js";

type InvoiceLine = StandardInvoice["lines"][number];
type ServiceRecord = StandardInvoice["serviceRecords"][number];

/**
 * Clean what a reader returned so the checks can trust the format.
 * Anything that can't be cleaned is listed in `problems` (→ the invoice goes to review).
 */
export function normalizeInvoice(raw: StandardInvoice): { invoice: StandardInvoice; problems: string[] } {
  const problems: string[] = [];
  // Each step below adds its own problems, so this order is the order the problems are listed in.
  const currency = cleanCurrency(raw.currency, problems);
  const invoiceNumber = cleanInvoiceNumber(raw.invoiceNumber, problems);
  const lines = cleanLines(raw.lines, problems);
  // `?? null` and `?? []` (here and below): results saved before a field existed don't have it.
  const servicePeriod = cleanServicePeriod(raw.servicePeriod ?? null, problems);
  const { subtotal, tax, fees, discounts, total } = cleanTotals(raw, problems);
  const invoiceDate = cleanDate("Invoice date", raw.invoiceDate, problems);
  const dueDate = cleanDate("Due date", raw.dueDate, problems);

  const invoice: StandardInvoice = {
    ...raw,
    pricesIncludeTax: pricesIncludeTaxFromNumbers(raw.pricesIncludeTax, subtotal, tax, fees, discounts, total),
    supplier: cleanSupplier(raw.supplier),
    bank: cleanBank(raw.bank),
    billTo: oneLine(raw.billTo ?? null),
    site: oneLine(raw.site ?? null),
    servicePeriod,
    serviceRecords: (raw.serviceRecords ?? []).map(cleanServiceRecord),
    otherInvoicesInFile: (raw.otherInvoicesInFile ?? []).map((otherNumber) => otherNumber.trim()).filter(Boolean),
    invoiceNumber,
    invoiceDate,
    dueDate,
    poNumber: trimOrNull(raw.poNumber),
    currency,
    lines,
    subtotal,
    tax,
    fees,
    discounts,
    total,
  };
  return { problems, invoice };
}

function cleanCurrency(value: string, problems: string[]): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`Currency is not a 3-letter code: "${value}"`);
  return currency;
}

function cleanInvoiceNumber(value: string, problems: string[]): string {
  const invoiceNumber = value.trim();
  if (invoiceNumber === "") problems.push("Invoice number is missing");
  return invoiceNumber;
}

function cleanLines(lines: InvoiceLine[], problems: string[]): InvoiceLine[] {
  const cleaned = lines.map((line, i) => cleanLine(line, `Line ${i + 1}`, problems));
  if (cleaned.length === 0) problems.push("No line items found");
  return cleaned;
}

/** One line item; `label` ("Line 2") names it in the problems. */
function cleanLine(line: InvoiceLine, label: string, problems: string[]): InvoiceLine {
  return {
    description: line.description.trim(),
    quantity: cleanQuantity(line.quantity, label, problems),
    unitPrice: cleanUnitPrice(line.unitPrice, label, problems),
    amount: cleanNumber(`${label} amount`, line.amount, problems),
  };
}

/** A blank quantity is not "0": the reader missed it (e.g. left it in the description). */
function cleanQuantity(value: string, label: string, problems: string[]): string {
  if (value.trim() === "") {
    problems.push(`${label} quantity is missing`);
    return "0";
  }
  return cleanNumber(`${label} quantity`, value, problems);
}

/** null = only an amount is printed (e.g. a monthly service charge). */
function cleanUnitPrice(value: string | null, label: string, problems: string[]): string | null {
  if (value == null || value.trim() === "") return null;
  return cleanNumber(`${label} unit price`, value, problems);
}

/** The service month as "2026-10" (a "2026-10-27" is cut to the month). */
function cleanServicePeriod(value: string | null, problems: string[]): string | null {
  const period = trimOrNull(value);
  if (!period) return null;
  if (/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(period)) return period.slice(0, MONTH_LENGTH);
  problems.push(`Service month is not YYYY-MM: "${period}"`);
  return null;
}

/** The invoice totals, as clean amounts. */
function cleanTotals(raw: StandardInvoice, problems: string[]) {
  return {
    subtotal: cleanNumber("Subtotal", raw.subtotal, problems),
    tax: cleanNumber("GST", raw.tax, problems),
    fees: cleanNumber("Fees", raw.fees, problems),
    // Kept positive whether printed "20.00" or "-20.00": the totals subtract it.
    discounts: D(cleanNumber("Discounts", raw.discounts, problems)).abs().toString(),
    total: cleanNumber("Total", raw.total, problems),
  };
}

/** The amount as cleanAmount gives it; "0" (and a problem) when it isn't a number. */
function cleanNumber(label: string, value: string, problems: string[]): string {
  const cleaned = cleanAmount(value);
  if (cleaned !== null) return cleaned;
  problems.push(`${label} is not a number: "${value}"`);
  return "0";
}

/** A YYYY-MM-DD date; null when blank, or (with a problem) when it isn't a real date. */
function cleanDate(label: string, value: string | null, problems: string[]): string | null {
  const date = trimOrNull(value);
  if (date === null) return null;
  if (isIsoDate(date)) return date;
  problems.push(`${label} is not a valid date: "${value}"`);
  return null;
}

/** A real calendar date written YYYY-MM-DD ("2026-02-30" is not). */
function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

function cleanSupplier(supplier: StandardInvoice["supplier"]): StandardInvoice["supplier"] {
  return {
    name: supplier.name.trim(),
    uen: trimOrNull(supplier.uen),
    gstRegNo: trimOrNull(supplier.gstRegNo),
    address: trimOrNull(supplier.address),
  };
}

function cleanBank(bank: StandardInvoice["bank"]): StandardInvoice["bank"] {
  return {
    accountHolder: trimOrNull(bank.accountHolder),
    accountNumber: trimOrNull(bank.accountNumber),
    swift: trimOrNull(bank.swift),
  };
}

/** Proof attached in the file. A date that isn't a real date is left out (the record then shows fewer dates). */
function cleanServiceRecord(record: ServiceRecord): ServiceRecord {
  return {
    kind: record.kind.trim(),
    site: oneLine(record.site),
    dates: record.dates.map((date) => date.trim()).filter(isIsoDate),
    signed: record.signed,
    notDone: record.notDone.map((item) => item.trim()).filter(Boolean),
  };
}

/** The text trimmed; null when there is none. */
function trimOrNull(text: string | null): string | null {
  if (text == null) return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/** An address or name printed over several lines → one line ("Siglap Centre, 55 Siglap Centre, Singapore …"). */
function oneLine(text: string | null): string | null {
  return trimOrNull(text?.replace(/\s*\n\s*/g, ", ") ?? null);
}
