import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StandardInvoice } from "../invoice.schema.js";
import { normId, normName, sameSite } from "../normalize.js";

// Re-exported so existing imports keep working.
export { normName } from "../normalize.js";

/** A supplier as keyed in our accounting data. */
export interface SupplierRecord {
  id: string;
  name: string;
  uen: string | null;
  gstRegNo: string | null;
  /** One account, or several when the supplier lists more than one (e.g. HSBC and Standard Chartered). */
  bankAccountNumber: string | string[];
}

/**
 * A PO line as keyed by our team. Goods: unitPrice and receivedQty (from the delivery).
 * Services: no receivedQty (the proof is the signed service record), priced by unitPrice or by amount
 * (the charge for orderedQty, e.g. the monthly charge; shared pro rata when fewer are billed).
 * Recurring (a frequency, e.g. "Weekly"): amount is the whole monthly charge. Its quantity counts visits, not what
 * the invoice counts, so only the amount is compared.
 */
export interface PoLine {
  description: string;
  /** The item code in our system, e.g. "MWRC03" (POs read from screenshots). */
  code?: string;
  /** How often the item is serviced ("Monthly", "Bi-weekly"…): a recurring monthly charge. */
  frequency?: string;
  unitPrice?: string;
  amount?: string;
  orderedQty: string;
  receivedQty?: string;
}

/** A purchase order: keyed by our team in data/, or read from screenshots of our system's PO page. */
export interface PurchaseOrder {
  poNumber: string;
  /** The supplier on file (keyed POs). A PO read from screenshots names it instead: supplierName. */
  supplierId?: string;
  supplierName?: string;
  currency: string;
  /** The delivery / service site, as an address (e.g. "2 Changi South Street 2, Singapore 486759"). */
  site?: string;
  /** YYYY-MM: the month the PO covers. */
  period?: string;
  /** YYYY-MM-DD: a recurring PO's contract start and end (it covers every month in between). */
  validFrom?: string;
  validTo?: string;
  /** As our system shows it, e.g. "APPROVED". */
  status?: string;
  lines: PoLine[];
}

/** A recurring PO (contract dates, or charges with a frequency) covers many months; any other PO is billed once. */
export function isRecurring(po: PurchaseOrder): boolean {
  return Boolean(po.validFrom || po.validTo) || po.lines.some((line) => line.frequency);
}

/** An invoice already in the accounting system. */
type RecordedInvoice = { supplierId: string; invoiceNumber: string; poNumber?: string };

/**
 * Where supplier, PO and delivery data comes from.
 * Today: JSON files in /data. Later: the accounting system's API (same methods, new class).
 */
export abstract class AccountingSource {
  /** The supplier who sent the invoice, found by UEN, GST reg. no. or name. */
  abstract findSupplier(invoice: StandardInvoice): Promise<SupplierRecord | null>;
  abstract findPo(poNumber: string): Promise<PurchaseOrder | null>;
  /** POs of this supplier for this month, and this site if given (for invoices that don't quote a PO number). */
  abstract findPosFor(supplierId: string, site: string | null, period: string): Promise<PurchaseOrder[]>;
  /** This supplier's invoice number is already recorded (so it would be paid twice). */
  abstract isAlreadyRecorded(supplierId: string, invoiceNumber: string): Promise<boolean>;
  /** Invoice numbers already recorded against this PO (a monthly service PO is billed once). */
  abstract recordedForPo(poNumber: string): Promise<string[]>;
  /** Load the latest data again (e.g. after the PO files were edited). */
  abstract reload(): Promise<void>;
}

/** The accounting data from suppliers.json, purchase-orders.json and recorded-invoices.json in the data folder. */
export class JsonAccountingSource extends AccountingSource {
  private suppliers: SupplierRecord[] = [];
  private pos: PurchaseOrder[] = [];
  private recorded: RecordedInvoice[] = [];

  constructor(private readonly dataDir: string) {
    super();
    this.load();
  }

  private load(): void {
    // Read all three before using any: a broken file leaves the data as it was, not half updated.
    const suppliers = readJson<SupplierRecord[]>(this.dataDir, "suppliers.json");
    const pos = readJson<PurchaseOrder[]>(this.dataDir, "purchase-orders.json");
    const recorded = readJson<RecordedInvoice[]>(this.dataDir, "recorded-invoices.json");
    dropBlankLineFields(pos);
    this.suppliers = suppliers;
    this.pos = pos;
    this.recorded = recorded;
  }

  async reload(): Promise<void> {
    this.load();
  }

  async findSupplier(invoice: StandardInvoice): Promise<SupplierRecord | null> {
    const { uen, gstRegNo, name } = invoice.supplier;
    // A GST reg. no. is often the UEN itself, so it is also looked up as a UEN.
    return (
      this.findSupplierById("uen", uen) ??
      this.findSupplierById("gstRegNo", gstRegNo) ??
      this.findSupplierById("uen", gstRegNo) ??
      this.suppliers.find((supplier) => normName(supplier.name) === normName(name)) ??
      null
    );
  }

  async findPo(poNumber: string): Promise<PurchaseOrder | null> {
    return this.pos.find((po) => normId(po.poNumber) === normId(poNumber)) ?? null;
  }

  async findPosFor(supplierId: string, site: string | null, period: string): Promise<PurchaseOrder[]> {
    return this.pos.filter((po) => {
      if (po.supplierId !== supplierId || po.period !== period) return false;
      if (site === null) return true;
      return po.site ? sameSite(po.site, site) : false;
    });
  }

  async recordedForPo(poNumber: string): Promise<string[]> {
    return this.recorded
      .filter((recorded) => recorded.poNumber && normId(recorded.poNumber) === normId(poNumber))
      .map((recorded) => recorded.invoiceNumber);
  }

  async isAlreadyRecorded(supplierId: string, invoiceNumber: string): Promise<boolean> {
    return this.recorded.some(
      (recorded) => recorded.supplierId === supplierId && normId(recorded.invoiceNumber) === normId(invoiceNumber),
    );
  }

  /** The supplier whose `field` is the same ID as `value`; none when the invoice doesn't give that ID. */
  private findSupplierById(field: "uen" | "gstRegNo", value: string | null): SupplierRecord | undefined {
    if (!value) return undefined;
    return this.suppliers.find((supplier) => {
      const idOnFile = supplier[field];
      return idOnFile ? normId(idOnFile) === normId(value) : false;
    });
  }
}

/** The supplier's bank accounts on file, as a list. */
export function bankAccounts(supplier: SupplierRecord): string[] {
  return Array.isArray(supplier.bankAccountNumber) ? supplier.bankAccountNumber : [supplier.bankAccountNumber];
}

/** One JSON file of the data folder; a missing or broken file is reported with its path. */
function readJson<T>(dataDir: string, file: string): T {
  const path = join(dataDir, file);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: ${reason}`);
  }
}

/** A price or quantity keyed as "" means "not given", like leaving it out. */
function dropBlankLineFields(pos: PurchaseOrder[]): void {
  for (const line of pos.flatMap((po) => po.lines ?? [])) {
    for (const field of ["unitPrice", "amount", "receivedQty"] as const) {
      if (line[field] === "") delete line[field];
    }
  }
}
