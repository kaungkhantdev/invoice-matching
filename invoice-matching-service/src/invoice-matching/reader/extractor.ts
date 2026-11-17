import type { AiProvider } from "../config.js";
import type { StandardInvoice } from "../invoice.schema.js";
import type { Prepared } from "./file-prep.js";

/**
 * An AI that reads one invoice file into OUR standard invoice.
 * Switch which one is used with AI_PROVIDER in .env: "claude" or "local".
 */
export abstract class InvoiceExtractor {
  abstract readonly provider: AiProvider;
  /** Shown in reports, e.g. "claude-opus-5-5" or "gemma4:12b". */
  abstract readonly model: string;
  abstract extract(fileName: string, prepared: Prepared): Promise<StandardInvoice>;
}

/** The same instructions for every AI, so results can be compared fairly. */
export const SYSTEM_PROMPT = `You read supplier invoices sent to a company in Singapore and copy their data into the given structure. Copy what the document says; don't correct or recalculate numbers, because separate checks compare them afterwards.

- Amounts: plain decimal strings without currency symbols or thousands separators, e.g. "1234.50". Use "0" for GST, fees or discounts the document doesn't show. Discounts are positive numbers.
- subtotal: the amount before GST, fees and discounts, as printed. If no subtotal is printed, use the sum of the line amounts.
- tax: the GST amount. pricesIncludeTax is true only when the line prices already include GST; it is false when GST is added below the subtotal.
- Dates: YYYY-MM-DD. Singapore documents write dates as DD/MM/YYYY, so read them that way unless the document clearly uses another format (a month name, or a supplier outside Singapore using MM/DD).
- currency: ISO 4217 code. A bare "$" on a Singapore invoice means SGD unless the document says otherwise.
- poNumber: the buyer's purchase order number (labels such as "PO", "P.O. No.", "Your PO", "Purchase Order"), or null. Don't use the supplier's own sales order or delivery order number.
- supplier.uen is the Unique Entity Number; supplier.gstRegNo is the GST registration number (often the same as the UEN). Use null when not shown. Copy IDs and account numbers character by character.
- bank: the supplier's account for payment, as printed. Use null for anything not shown.
- uncertainFields: names of fields you couldn't read clearly, had to guess, or found missing (e.g. "total", "lines[1].quantity"). Leave it empty when everything was clear.`;

export const USER_INSTRUCTION = "Copy this supplier invoice into the structure.";

/**
 * A temporary problem (rate limit, server busy or down, timeout): the queue tries the invoice
 * again later instead of sending it to review.
 */
export class RetryableError extends Error {}
