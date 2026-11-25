import {
  isRecurring,
  type AccountingSource,
  type PurchaseOrder,
  type SupplierRecord,
} from "./accounting/accounting.source.js";
import type { PoFoundBy } from "./checker/checker.service.js";
import type { StandardInvoice } from "./invoice.schema.js";
import { normId, sameCompany } from "./normalize.js";

/**
 * The PO our team keyed for an invoice: by the PO number on it; if there is none, by supplier + site + month.
 * When that finds no single PO, also what helps a reviewer: how many POs fit, or the supplier's POs that month.
 */
export async function findKeyedPo(
  accounting: AccountingSource,
  invoice: StandardInvoice,
  supplier: SupplierRecord | null,
  month: string | null,
): Promise<{ po: PurchaseOrder | null; poFoundBy: PoFoundBy; poCandidates: number; sameMonthPos: PurchaseOrder[] }> {
  if (invoice.poNumber) {
    const po = await accounting.findPo(invoice.poNumber);
    return { po, poFoundBy: po ? "number" : null, poCandidates: 0, sameMonthPos: [] };
  }
  if (!supplier || !month) return { po: null, poFoundBy: null, poCandidates: 0, sameMonthPos: [] };

  const candidates = await findPosForSite(accounting, invoice, supplier.id, month);
  if (candidates.length === 1) {
    return { po: candidates[0], poFoundBy: "site and month", poCandidates: 1, sameMonthPos: [] };
  }
  // None for this site: show the supplier's POs for the month, so a misread or mis-keyed site is easy to spot.
  const sameMonthPos = candidates.length === 0 ? await accounting.findPosFor(supplier.id, null, month) : [];
  return { po: null, poFoundBy: null, poCandidates: candidates.length, sameMonthPos };
}

/**
 * Who billed this PO already: an earlier invoice in this batch (`billedInBatch`: poBillingKey → file name),
 * else the invoices recorded against it (a monthly service PO is billed once). `month`: the invoice's month.
 */
export async function findPoAlreadyBilledBy(
  accounting: AccountingSource,
  po: PurchaseOrder | null,
  invoiceNumber: string,
  month: string | null,
  billedInBatch: Map<string, string>,
): Promise<string | null> {
  if (!po) return null;
  const inBatch = billedInBatch.get(poBillingKey(po, month));
  if (inBatch !== undefined) return inBatch;
  // recorded-invoices.json has no month, so it can only tell for a PO that is billed once in all.
  if (isRecurring(po)) return null;
  const recorded = await accounting.recordedForPo(po.poNumber);
  const recordedByOthers = recorded.filter((number) => normId(number) !== normId(invoiceNumber));
  if (recordedByOthers.length === 0) return null;
  return `recorded invoice ${recordedByOthers.join(", ")}`;
}

/** What one invoice may bill once: the PO; a recurring PO once a month ("GEN000073|2026-10"). */
export function poBillingKey(po: PurchaseOrder, month: string | null): string {
  return isRecurring(po) ? `${normId(po.poNumber)}|${month ?? ""}` : normId(po.poNumber);
}

/** The invoice is from the PO's supplier: the one on file (keyed POs), or the one it names (uploaded POs). */
export function isPoSupplier(po: PurchaseOrder, invoice: StandardInvoice, supplier: SupplierRecord | null): boolean {
  if (po.supplierId) return supplier?.id === po.supplierId;
  const poSupplier = po.supplierName;
  if (!poSupplier) return false;
  return [invoice.supplier.name, supplier?.name].some((name) => name != null && sameCompany(poSupplier, name));
}

/**
 * The supplier's POs for the month at the invoice's site; if that finds nothing (e.g. only "ICFM-Siglap Centre"
 * is printed), at the address on a signed service record attached to it.
 */
async function findPosForSite(
  accounting: AccountingSource,
  invoice: StandardInvoice,
  supplierId: string,
  month: string,
): Promise<PurchaseOrder[]> {
  const signedRecordSites = invoice.serviceRecords.filter((record) => record.signed).map((record) => record.site);
  const sites = [invoice.site, ...signedRecordSites].filter((site): site is string => Boolean(site));
  for (const site of new Set(sites)) {
    const found = await accounting.findPosFor(supplierId, site, month);
    if (found.length) return found;
  }
  return [];
}
