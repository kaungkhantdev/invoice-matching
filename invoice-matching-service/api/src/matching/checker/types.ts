import type { PurchaseOrder, SupplierRecord } from "../accounting/accounting.source.js";
import type { TextractRead } from "../reader/textract.reader.js";

/** How one check came out. A note still matches; a fail sends the invoice to review. */
export type CheckStatus = "pass" | "note" | "fail" | "skip";

/** The verdict for the whole invoice. */
export type Outcome = "MATCHED" | "MATCHED_WITH_NOTE" | "REVIEW";

/** One check as the page shows it: its number (0–6), name, status, and what it found in words. */
export interface CheckResult {
  id: number;
  name: string;
  status: CheckStatus;
  details: string[];
}

/** What the checks need besides the invoice: its supplier and PO on file, and what the batch saw. */
export interface CheckContext {
  supplier: SupplierRecord | null;
  po: PurchaseOrder | null;
  alreadyRecorded: boolean;
  /** File name of an earlier copy of this invoice in the same batch, if any. */
  duplicateInBatch: string | null;
  /** Problems found while cleaning the data the reader returned. */
  readProblems: string[];
  /** What Amazon Textract found on the same pages, to compare with the AI. */
  textract?: TextractRead | null;
  /** How the PO was found: by the PO number on the invoice, or (no number) by supplier + site + month. */
  poFoundBy?: PoFoundBy;
  /** With no PO number: how many keyed POs fit this supplier, site and month. */
  poCandidates?: number;
  /** With no PO number and none for this site: the supplier's POs for the same month (a hint for the reviewer). */
  sameMonthPos?: PurchaseOrder[];
  /** An earlier invoice in this batch, or a recorded one, already billed this PO (this month, if it recurs). */
  poAlreadyBilledBy?: string | null;
  /** The PO was uploaded with the invoice (screenshots): why it couldn't be read, or what doesn't add up on it. */
  uploadedPo?: { error: string | null; problems: string[] };
}

/**
 * How the PO was found: by the PO number on the invoice, or (no number) by supplier + site + month, among the POs
 * keyed in data/; or uploaded with the invoice. null: no PO found.
 */
export type PoFoundBy = "number" | "site and month" | "uploaded" | null;

/** One invoice line next to its PO line, for check 3 and the review page. */
export interface LineComparison {
  line: number;
  description: string;
  quantity: string;
  /** Invoice unit price before GST, rounded to cents (null when the invoice prints only an amount). */
  invoicePriceExTax: string | null;
  /** Invoice line amount before GST. */
  invoiceAmountExTax: string;
  /** What the PO allows for this line's quantity (unit price × qty, or its amount pro rata); null if no price. */
  poAllowed: string | null;
  /** The paired PO line, prices formatted like the invoice's; null when the line is not on the PO. */
  po: {
    description: string;
    unitPrice: string | null;
    amount: string | null;
    orderedQty: string;
    receivedQty: string | null;
    /** A recurring line: "Monthly", "Weekly"… (its amount is the monthly charge). */
    frequency: string | null;
  } | null;
  /** A free line (0.00) that isn't on the PO, e.g. a loaned dispenser: nothing to check. */
  free: boolean;
  priceStatus: "pass" | "note" | "fail";
  /** What the price difference costs on this line (qty × difference), or null if the price matches. */
  priceEffect: string | null;
  qtyStatus: "pass" | "fail";
  /** All invoiced quantity for this PO line (several invoice lines can share one PO line). */
  invoicedOnPoLine: string | null;
  /** The most that may be invoiced: the received qty (goods) or the ordered qty (services); null for recurring lines. */
  cap: string | null;
  capFrom: "received" | "ordered" | null;
  /** What is wrong with the price or the quantity, in words (check 3 and the page show the same text). */
  priceNote: string | null;
  qtyNote: string | null;
}
