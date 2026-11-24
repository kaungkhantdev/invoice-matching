import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StandardInvoice } from "../invoice.schema.js";
import { normId, sameSite } from "../normalize.js";

export interface SupplierRecord {
  id: string;
  name: string;
  uen: string | null;
  gstRegNo: string | null;
  /** One account, or several when the supplier lists more than one (e.g. HSBC and Standard Chartered). */
  bankAccountNumber: string | string[];
}

/** The supplier's bank accounts on file, as a list. */
export const bankAccounts = (s: SupplierRecord): string[] =>
  Array.isArray(s.bankAccountNumber) ? s.bankAccountNumber : [s.bankAccountNumber];

/**
 * A PO line as keyed by our team. Goods: unitPrice and receivedQty (from the delivery).
 * Services: no receivedQty (the proof is the signed service record), priced by unitPrice or by amount
 * (the charge for orderedQty, e.g. the monthly charge; shared pro rata when fewer are billed).
 */
export interface PoLine {
  description: string;
  unitPrice?: string;
  amount?: string;
  orderedQty: string;
  receivedQty?: string;
}

export interface PurchaseOrder {
  poNumber: string;
  supplierId: string;
  currency: string;
  /** The delivery / service site, as an address (e.g. "2 Changi South Street 2, Singapore 486759"). */
  site?: string;
  /** YYYY-MM: the month the PO covers. */
  period?: string;
  lines: PoLine[];
}

/**
 * Where supplier, PO and delivery data comes from.
 * Today: JSON files in /data. Later: the accounting system's API (same methods, new class).
 */
export abstract class AccountingSource {
  abstract findSupplier(invoice: StandardInvoice): Promise<SupplierRecord | null>;
  abstract findPo(poNumber: string): Promise<PurchaseOrder | null>;
  /** POs of this supplier for this month, and this site if given (for invoices that don't quote a PO number). */
  abstract findPosFor(supplierId: string, site: string | null, period: string): Promise<PurchaseOrder[]>;
  abstract isAlreadyRecorded(supplierId: string, invoiceNumber: string): Promise<boolean>;
  /** Invoice numbers already recorded against this PO (a monthly service PO is billed once). */
  abstract recordedForPo(poNumber: string): Promise<string[]>;
  /** Load the latest data again (e.g. after the PO files were edited). */
  abstract reload(): Promise<void>;
}

/** Company names without "Pte. Ltd." etc., for matching a supplier by name. */
export const normName = (s: string) =>
  normId(s.replace(/\b(pte|private|ltd|limited|llp|co|company|inc)\b\.?/gi, ""));

export class JsonAccountingSource extends AccountingSource {
  private suppliers: SupplierRecord[] = [];
  private pos: PurchaseOrder[] = [];
  private recorded: { supplierId: string; invoiceNumber: string; poNumber?: string }[] = [];

  constructor(private readonly dataDir: string) {
    super();
    this.load();
  }

  private load(): void {
    const read = <T>(file: string): T => JSON.parse(readFileSync(join(this.dataDir, file), "utf8")) as T;
    this.suppliers = read("suppliers.json");
    this.pos = read("purchase-orders.json");
    this.recorded = read("recorded-invoices.json");
  }

  async reload(): Promise<void> {
    this.load();
  }

  async findSupplier(invoice: StandardInvoice): Promise<SupplierRecord | null> {
    const { uen, gstRegNo, name } = invoice.supplier;
    const byId = (value: string | null, field: "uen" | "gstRegNo") =>
      value ? this.suppliers.find((s) => s[field] && normId(s[field]!) === normId(value)) : undefined;
    return (
      byId(uen, "uen") ??
      byId(gstRegNo, "gstRegNo") ??
      byId(gstRegNo, "uen") ??
      this.suppliers.find((s) => normName(s.name) === normName(name)) ??
      null
    );
  }

  async findPo(poNumber: string): Promise<PurchaseOrder | null> {
    return this.pos.find((p) => normId(p.poNumber) === normId(poNumber)) ?? null;
  }

  async findPosFor(supplierId: string, site: string | null, period: string): Promise<PurchaseOrder[]> {
    return this.pos.filter(
      (p) => p.supplierId === supplierId && p.period === period && (site === null || (p.site && sameSite(p.site, site))),
    );
  }

  async recordedForPo(poNumber: string): Promise<string[]> {
    return this.recorded.filter((r) => r.poNumber && normId(r.poNumber) === normId(poNumber)).map((r) => r.invoiceNumber);
  }

  async isAlreadyRecorded(supplierId: string, invoiceNumber: string): Promise<boolean> {
    return this.recorded.some(
      (r) => r.supplierId === supplierId && normId(r.invoiceNumber) === normId(invoiceNumber),
    );
  }
}

