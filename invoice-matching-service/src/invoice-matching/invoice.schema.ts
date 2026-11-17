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
      unitPrice: z.string(),
      amount: z.string(),
    }),
  ),
  subtotal: z.string(),
  tax: z.string(),
  fees: z.string(),
  discounts: z.string(),
  total: z.string(),
  uncertainFields: z.array(z.string()),
});

export type StandardInvoice = z.infer<typeof InvoiceSchema>;

export type ReadBy = "xml" | "claude" | "local";
