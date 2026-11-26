import { z } from "zod";

/**
 * A PO as read from screenshots (or a printout) of our own system's PO page, copied as shown.
 * uploadedPo() turns it into the PurchaseOrder the checks use, and says what doesn't add up.
 */
export const PoSchema = z.object({
  documentType: z.enum(["purchase_order", "other"]),
  poNumber: z.string().nullable(),
  status: z.string().nullable(),
  /** As shown; not used by the checks. */
  orderDate: z.string().nullable(),
  supplierName: z.string().nullable(),
  /** The delivery site's address. */
  site: z.string().nullable(),
  currency: z.string(),
  contractRef: z.string().nullable(),
  /**
   * The contract's start and end, copied as shown, e.g. "05/11/2026" (DD/MM/YYYY): uploadedPo() turns them into
   * dates, not the AI. A recurring PO covers every month in between.
   */
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  lines: z.array(
    z.object({
      code: z.string().nullable(),
      description: z.string(),
      /** "Monthly", "Weekly", "Bi-weekly", "Bi-monthly"…, or null when the page shows none. */
      frequency: z.string().nullable(),
      quantity: z.string(),
      unitPrice: z.string().nullable(),
      total: z.string(),
    }),
  ),
  grandTotal: z.string().nullable(),
  uncertainFields: z.array(z.string()),
});

export type PoRead = z.infer<typeof PoSchema>;
