import { z } from "zod";

/** Document types that are invoices; anything else (a quotation, a statement, a credit note…) is not. */
export const INVOICE_TYPES = ["tax_invoice", "invoice"];

/**
 * OUR standard invoice. Every supplier invoice, whatever its format, becomes this shape.
 * Amounts are decimal strings ("1234.50") so we never do money math with JS numbers.
 */
export const InvoiceSchema = z.object({
  documentType: z.enum([
    "tax_invoice",
    "invoice",
    "credit_note",
    "quotation",
    "statement",
    "delivery_order",
    "receipt",
    "other",
  ]),
  supplier: z.object({
    name: z.string(),
    uen: z.string().nullable(),
    gstRegNo: z.string().nullable(),
    address: z.string().nullable(),
  }),
  bank: z.object({
    accountHolder: z.string().nullable(),
    accountNumber: z.string().nullable(),
    swift: z.string().nullable(),
  }),
  /** Who the invoice is addressed to ("Bill to"). Must be us. */
  billTo: z.string().nullable(),
  /** The delivery / service site the invoice is for (not the bill-to address). */
  site: z.string().nullable(),
  /** YYYY-MM: the month the goods or services are for. */
  servicePeriod: z.string().nullable(),
  invoiceNumber: z.string(),
  invoiceDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  poNumber: z.string().nullable(),
  currency: z.string(),
  pricesIncludeTax: z.boolean(),
  lines: z.array(
    z.object({
      description: z.string(),
      quantity: z.string(),
      /** null when the invoice prints only an amount (e.g. a monthly service charge). */
      unitPrice: z.string().nullable(),
      amount: z.string(),
    }),
  ),
  subtotal: z.string(),
  tax: z.string(),
  fees: z.string(),
  discounts: z.string(),
  total: z.string(),
  uncertainFields: z.array(z.string()),
  /** Proof attached in the same file: service reports, service cards, delivery orders (one entry each). */
  serviceRecords: z.array(
    z.object({
      kind: z.string(),
      site: z.string().nullable(),
      /** YYYY-MM-DD visit or delivery dates on the record. */
      dates: z.array(z.string()),
      /** Signed or chopped by the customer. */
      signed: z.boolean(),
      /** Items the record says were not done or not delivered (no stock, 0 done…). */
      notDone: z.array(z.string()),
    }),
  ),
  /** Numbers of OTHER invoices found in the same file (a file must hold one invoice). */
  otherInvoicesInFile: z.array(z.string()),
});

export type StandardInvoice = z.infer<typeof InvoiceSchema>;

/** How the invoice was read: from InvoiceNow XML, or by Claude on Bedrock. */
export type ReadBy = "xml" | "bedrock";

/** Where monthOf found the month. */
export type MonthFrom = "stated" | "service records" | "invoice date";

/** "2026-10-27".slice(0, MONTH_LENGTH) = "2026-10". */
export const MONTH_LENGTH = "YYYY-MM".length;

/**
 * The month an invoice is for: the one it states; else the month most of its signed service records fall in
 * (invoices billed in arrears are dated the month after); else the month of the invoice date.
 */
export function monthOf(
  invoice: Pick<StandardInvoice, "servicePeriod" | "invoiceDate"> & {
    serviceRecords?: StandardInvoice["serviceRecords"];
  },
): { month: string | null; from: MonthFrom | null } {
  if (invoice.servicePeriod) return { month: invoice.servicePeriod, from: "stated" };

  const recordsMonth = busiestSignedMonth(invoice.serviceRecords ?? []);
  if (recordsMonth !== null) return { month: recordsMonth, from: "service records" };

  const invoiceDateMonth = invoice.invoiceDate?.slice(0, MONTH_LENGTH) ?? null;
  return { month: invoiceDateMonth, from: invoiceDateMonth ? "invoice date" : null };
}

/** The month with the most dates on signed service records (the earlier month on a tie); null when there are none. */
function busiestSignedMonth(records: StandardInvoice["serviceRecords"]): string | null {
  const datesPerMonth = new Map<string, number>();
  for (const record of records) {
    if (!record.signed) continue;
    for (const date of record.dates) {
      const month = date.slice(0, MONTH_LENGTH);
      datesPerMonth.set(month, (datesPerMonth.get(month) ?? 0) + 1);
    }
  }
  const [busiest] = [...datesPerMonth.entries()].sort(
    ([monthA, countA], [monthB, countB]) => countB - countA || monthA.localeCompare(monthB),
  );
  return busiest ? busiest[0] : null;
}
