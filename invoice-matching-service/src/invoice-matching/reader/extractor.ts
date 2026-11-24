import type { AiProvider } from "../config.js";
import type { StandardInvoice } from "../invoice.schema.js";
import type { Prepared } from "./file-prep.js";

/**
 * An AI that reads one invoice file into OUR standard invoice.
 * Switch which one is used with AI_PROVIDER in .env: "bedrock" (default), "claude" or "local".
 */
export abstract class InvoiceExtractor {
  abstract readonly provider: AiProvider;
  /** Shown in reports, e.g. "anthropic.claude-sonnet-5" or "gemma4:12b". */
  abstract readonly model: string;
  /** `ocr`: the text Amazon Textract read from the same file (null for spreadsheets, or with TEXTRACT=off). */
  abstract extract(fileName: string, prepared: Prepared, ocr?: string | null): Promise<StandardInvoice>;
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
- bank: the supplier's account for payment, as printed. If several are printed, copy the first. Use null for anything not shown.
- billTo: the customer the invoice is addressed to ("Bill to", "Customer"), name as printed.
- site: the delivery or service site this invoice is for: its name and its address with postal code when shown (e.g. "SLC 1, 2 Changi South Street 2, Singapore 486759"). Not the bill-to address. null if none is shown.
- servicePeriod: YYYY-MM, the month the goods or services are for when the invoice says so (e.g. "Service for October 2026" → "2026-10"); otherwise null.
- lines: one per printed line. quantity is the number of units; when a line starts with it ("21 Signature Dual Sanitiser") put it in quantity, not in the description. unitPrice is null when only an amount is printed; amount is "0" when a line shows no amount (included or free items).
- serviceRecords: one entry per service report, service card, service docket or delivery order attached in the file (a second copy of the same record counts once): kind, site (its address with postal code when shown, otherwise its site name), dates (YYYY-MM-DD), signed (true only if the customer signed or chopped it), notDone (items it says were not done or not delivered, e.g. no stock, 0 done, fewer done than due: name each item as the invoice line names it, then the reason, e.g. "HWSC EcoWash Pearl Creme -5L: No Stock, 0 of 5 done"). Empty if none is attached.
- otherInvoicesInFile: if the file holds more than one invoice, copy only the FIRST one and list the other invoice numbers here. Otherwise empty.
- Ignore marks the customer added (handwritten approvals or notes, highlight boxes, labels): they are not part of the supplier's document.
- uncertainFields: names of fields you couldn't read clearly, had to guess, or found missing (e.g. "total", "lines[1].quantity"). Leave it empty when everything was clear.`;

export const USER_INSTRUCTION = "Copy this supplier invoice into the structure.";

/** The user message's text part: Textract's text (if any), then the instruction. */
export function instructionWithOcr(ocr: string | null | undefined): string {
  if (!ocr) return USER_INSTRUCTION;
  return [
    `<ocr source="Amazon Textract">\n${ocr}\n</ocr>`,
    "The <ocr> text was read from this same document by Amazon Textract (OCR). Use it to help read small print. " +
      "The document itself is the source of truth: where the OCR text differs from what the document clearly shows, " +
      "copy the document. If a value is unclear in the document and you took it from the OCR text, or you can't tell " +
      "which is right, list that field in uncertainFields.",
    USER_INSTRUCTION,
  ].join("\n\n");
}

/**
 * A temporary problem (rate limit, server busy or down, timeout): the queue tries the invoice
 * again later instead of sending it to review.
 */
export class RetryableError extends Error {}
