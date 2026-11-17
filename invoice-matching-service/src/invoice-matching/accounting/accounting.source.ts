import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StandardInvoice } from "../invoice.schema.js";
import { normId } from "../normalize.js";

export interface SupplierRecord {
  id: string;
  name: string;
  uen: string | null;
  gstRegNo: string | null;
  bankAccountNumber: string;
}

export interface PoLine {
  description: string;
  unitPrice: string;
  orderedQty: string;
  receivedQty: string;
}

export interface PurchaseOrder {
  poNumber: string;
  supplierId: string;
  currency: string;
  lines: PoLine[];
}

/**
 * Where supplier, PO and delivery data comes from.
 * Today: JSON files in /data. Later: the accounting system's API (same methods, new class).
 */
export abstract class AccountingSource {
  abstract findSupplier(invoice: StandardInvoice): Promise<SupplierRecord | null>;
  abstract findPo(poNumber: string): Promise<PurchaseOrder | null>;
  abstract isAlreadyRecorded(supplierId: string, invoiceNumber: string): Promise<boolean>;
  /** Load the latest data again (e.g. after the PO files were edited). */
  abstract reload(): Promise<void>;
}

/** Company names without "Pte. Ltd." etc., for matching a supplier by name. */
export const normName = (s: string) =>
  normId(s.replace(/\b(pte|private|ltd|limited|llp|co|company|inc)\b\.?/gi, ""));

export class JsonAccountingSource extends AccountingSource {
  private suppliers: SupplierRecord[] = [];
  private pos: PurchaseOrder[] = [];
  private recorded: { supplierId: string; invoiceNumber: string }[] = [];

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

  async isAlreadyRecorded(supplierId: string, invoiceNumber: string): Promise<boolean> {
    return this.recorded.some(
      (r) => r.supplierId === supplierId && normId(r.invoiceNumber) === normId(invoiceNumber),
    );
  }
}

