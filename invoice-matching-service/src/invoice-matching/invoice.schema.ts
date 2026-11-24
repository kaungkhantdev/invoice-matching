import { z } from "zod";

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

export type ReadBy = "xml" | "bedrock" | "claude" | "local";

export type MonthFrom = "stated" | "service records" | "invoice date";

/**
 * The month an invoice is for: the one it states; else the month most of its signed service records fall in
 * (invoices billed in arrears are dated the month after); else the month of the invoice date.
 */
export function monthOf(
  inv: Pick<StandardInvoice, "servicePeriod" | "invoiceDate"> & { serviceRecords?: StandardInvoice["serviceRecords"] },
): { month: string | null; from: MonthFrom | null } {
  if (inv.servicePeriod) return { month: inv.servicePeriod, from: "stated" };
  const counts = new Map<string, number>();
  for (const r of inv.serviceRecords ?? []) {
    if (!r.signed) continue;
    for (const d of r.dates) counts.set(d.slice(0, 7), (counts.get(d.slice(0, 7)) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (best) return { month: best[0], from: "service records" };
  const fromDate = inv.invoiceDate?.slice(0, 7) ?? null;
  return { month: fromDate, from: fromDate ? "invoice date" : null };
}

export const servicePeriodOf = (inv: Parameters<typeof monthOf>[0]): string | null => monthOf(inv).month;
