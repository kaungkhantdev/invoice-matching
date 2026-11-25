// What the NestJS API under /api returns. Mirrors api/src/invoices/invoice.view.ts,
// api/src/invoices/status.controller.ts and the result types in api/src/matching
// (matching.service.ts, invoice.schema.ts, checker/types.ts).
// The API works everything out (checks, comparisons, counts, notes); the page only shows it.

export type InvoiceState = "QUEUED" | "READING" | "DONE";
export type Outcome = "MATCHED" | "MATCHED_WITH_NOTE" | "REVIEW";
export type CheckStatus = "pass" | "note" | "fail" | "skip";
export type ReadBy = "xml" | "bedrock";
/** How the PO was found: by number or by supplier + site + month in data/, or uploaded with the invoice. */
export type PoFoundBy = "number" | "site and month" | "uploaded" | null;
export type MonthFrom = "stated" | "service records" | "invoice date";
export type DecisionStatus = "APPROVED" | "REJECTED";
export type PreviewKind = "image" | "pages" | "text" | "none";

/** GET /api/status */
export interface Status {
  ai: { name: string; model: string; region: string };
  ocr: { name: string; region: string };
  awsLogin: "found" | "missing";
  hint: string | null;
  queue: { waiting: number; reading: number; limit: number };
  upload: { accept: string; maxBytes: number; poAccept: string; maxPoFiles: number };
}

/** An approval or rejection, with its note. */
export interface Decision {
  status: DecisionStatus;
  note: string;
  at: string;
  /** The result the person saw when deciding. */
  outcome: string;
}

/** One row of GET /api/invoices. */
export interface InvoiceSummary {
  id: string;
  seq: number;
  file: string;
  state: InvoiceState;
  outcome: Outcome | null;
  supplier: string | null;
  invoiceNumber: string | null;
  /** The PO it was matched to: printed on the invoice, or found by supplier + site + month. */
  poNumber: string | null;
  poFoundBy: PoFoundBy;
  currency: string | null;
  total: string | null;
  readBy: ReadBy | null;
  model: string | null;
  seconds: number | null;
  /** Checked against a PO uploaded with it (screenshots), not one keyed in data/. */
  withPo: boolean;
  attempts: number;
  retryError: string | null;
  problems: string[];
  decision: Decision | null;
  /** Checked, sorted to Review, and nobody has approved or rejected it yet. */
  needsReview: boolean;
  updatedAt: number;
}

/** GET /api/invoices/:id */
export interface InvoiceDetail extends InvoiceSummary {
  addedAt: string;
  size: number;
  result: InvoiceResult | null;
  review: Review | null;
  error: string | null;
  previewKind: PreviewKind;
  previewText: string | null;
  pages: number;
  /** The PO uploaded with the invoice (null: checked against data/). */
  po: UploadedPo | null;
}

/** The PO uploaded with an invoice: screenshots (or a printout) of our system's PO page. */
export interface UploadedPo {
  files: PoFile[];
  /** Why the PO couldn't be read (check 2 says it too). */
  error: string | null;
  model: string | null;
  seconds: number | null;
}

/** One PO file, numbered 1, 2, … in the order uploaded. */
export interface PoFile {
  n: number;
  file: string;
  previewKind: PreviewKind;
  previewText: string | null;
  pages: number;
}

/** A value read from the invoice next to the one on file; differs = show it red. */
export interface OnFile {
  onFile: string | null;
  differs: boolean;
}

/** What the page shows next to the file (only for checked invoices). */
export interface Review {
  onFile: { uen: OnFile; gstRegNo: OnFile; bank: OnFile };
  serviceProof: string;
  checksPassed: number;
  checks: number;
  linesMatched: number;
  lines: number;
}

/** POST /api/invoices/with-po */
export interface AddResult {
  added: InvoiceSummary[];
  skipped: string[];
}

/** One of the 7 checks, with what it found. */
export interface CheckResult {
  id: number;
  name: string;
  status: CheckStatus;
  details: string[];
}

/** Proof attached in the same file: a service report, service card or delivery order. */
export interface ServiceRecord {
  kind: string;
  site: string | null;
  dates: string[];
  signed: boolean;
  notDone: string[];
}

/** What was read from the invoice file. */
export interface StandardInvoice {
  documentType: "tax_invoice" | "invoice" | "credit_note" | "quotation"
    | "statement" | "delivery_order" | "receipt" | "other";
  supplier: { name: string; uen: string | null; gstRegNo: string | null; address: string | null };
  bank: { accountHolder: string | null; accountNumber: string | null; swift: string | null };
  billTo: string | null;
  site: string | null;
  servicePeriod: string | null;
  invoiceNumber: string;
  invoiceDate: string | null;
  dueDate: string | null;
  poNumber: string | null;
  currency: string;
  pricesIncludeTax: boolean;
  lines: { description: string; quantity: string; unitPrice: string | null; amount: string }[];
  subtotal: string;
  tax: string;
  fees: string;
  discounts: string;
  total: string;
  uncertainFields: string[];
  serviceRecords: ServiceRecord[];
  otherInvoicesInFile: string[];
}

/** A supplier on file (data/). */
export interface SupplierRecord {
  id: string;
  name: string;
  uen: string | null;
  gstRegNo: string | null;
  bankAccountNumber: string | string[];
}

export interface PoLine {
  description: string;
  code?: string;
  /** "Monthly", "Weekly"…: a recurring line, its amount is the monthly charge. */
  frequency?: string;
  unitPrice?: string;
  amount?: string;
  orderedQty: string;
  receivedQty?: string;
}

/** A PO: keyed in data/, or read from the screenshots uploaded with the invoice. */
export interface PurchaseOrder {
  poNumber: string;
  supplierId?: string;
  supplierName?: string;
  currency: string;
  site?: string;
  period?: string;
  /** A recurring PO's contract start and end (YYYY-MM-DD). */
  validFrom?: string;
  validTo?: string;
  status?: string;
  lines: PoLine[];
}

/** One invoice line next to its PO line. */
export interface LineComparison {
  line: number;
  description: string;
  quantity: string;
  invoicePriceExTax: string | null;
  invoiceAmountExTax: string;
  poAllowed: string | null;
  po: {
    description: string;
    unitPrice: string | null;
    amount: string | null;
    orderedQty: string;
    receivedQty: string | null;
    frequency: string | null;
  } | null;
  /** A free line (0.00) that isn't on the PO: nothing to check. */
  free: boolean;
  priceStatus: "pass" | "note" | "fail";
  priceEffect: string | null;
  qtyStatus: "pass" | "fail";
  invoicedOnPoLine: string | null;
  /** The most that may be invoiced: received (goods) or ordered (services). */
  cap: string | null;
  capFrom: "received" | "ordered" | null;
  priceNote: string | null;
  qtyNote: string | null;
}

/** What the invoice was compared with. */
export interface MatchContext {
  supplier: SupplierRecord | null;
  po: PurchaseOrder | null;
  poFoundBy: PoFoundBy;
  month: { value: string | null; from: MonthFrom | null };
  lines: LineComparison[];
}

/** The full result for one invoice: what was read, the checks, and what it was compared with. */
export interface InvoiceResult {
  file: string;
  outcome: Outcome;
  readBy: ReadBy | null;
  model: string | null;
  invoice: StandardInvoice | null;
  checks: CheckResult[];
  error: string | null;
  context: MatchContext | null;
  invoiceKey: string | null;
}
