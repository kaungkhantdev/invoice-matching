import { config } from "../../../config.js";
import type { PurchaseOrder } from "../../accounting/accounting.source.js";
import { MONTH_LENGTH, monthOf, type StandardInvoice } from "../../invoice.schema.js";
import { normId, sameCompany, sameSite } from "../../normalize.js";
import { isPoSupplier } from "../../po-lookup.js";
import { checkResult, type Finding } from "../findings.js";
import type { CheckContext, CheckResult } from "../types.js";

/** With no PO found, the reviewer is shown at most this many of the supplier's POs for the month. */
const MAX_HINTED_POS = 3;

/**
 * Check 2: PO exists: billed to us; the PO (keyed in data/, or uploaded with the invoice) is this supplier's,
 * approved, in the same currency, for the same site and month.
 */
export function poExists(invoice: StandardInvoice, context: CheckContext): CheckResult {
  const findings: (Finding | null)[] = billedToUs(invoice);
  if (context.uploadedPo) findings.push(...uploadedPoProblems(context.uploadedPo));
  if (context.po) findings.push(...poMismatches(invoice, context, context.po));
  else if (!context.uploadedPo) findings.push(noPo(invoice, context));
  return checkResult(2, "PO exists", findings);
}

/** The invoice must be billed to one of our company names (when they are set). */
function billedToUs(invoice: StandardInvoice): Finding[] {
  if (!config.buyerNames.length) return [];
  const billTo = invoice.billTo;
  if (!billTo) return [{ status: "note", text: "Can't see who the invoice is billed to" }];
  const isUs = config.buyerNames.some((name) => sameCompany(name, billTo));
  return isUs ? [] : [{ status: "fail", text: `Billed to "${billTo}", not to us` }];
}

/** The PO uploaded with the invoice couldn't be read, or doesn't add up: then nothing compared with it is sure. */
function uploadedPoProblems(uploaded: NonNullable<CheckContext["uploadedPo"]>): Finding[] {
  if (uploaded.error) return [{ status: "fail", text: `Couldn't read the PO: ${uploaded.error}` }];
  return uploaded.problems.map((problem) => ({ status: "fail" as const, text: `PO: ${problem}` }));
}

/** Why there is no PO: its number isn't on file, or (no number) no PO or several fit. */
function noPo(invoice: StandardInvoice, context: CheckContext): Finding {
  if (invoice.poNumber) return { status: "fail", text: `PO ${invoice.poNumber} not found` };
  const candidates = context.poCandidates ?? 0;
  if (candidates > 1) {
    const text = `No PO number on the invoice, and ${candidates} POs fit this supplier, site and month`;
    return { status: "fail", text };
  }
  const siteRead = invoice.site ? ` (site read: "${invoice.site}")` : "";
  const noneFits = `No PO number on the invoice, and no PO for this supplier, site and month${siteRead}`;
  return { status: "fail", text: `${noneFits}${sameMonthHint(context)}` };
}

/** A hint for the reviewer: the supplier's POs for the same month, so a misread site can be spotted. */
function sameMonthHint(context: CheckContext): string {
  const nearPos = (context.sameMonthPos ?? []).slice(0, MAX_HINTED_POS);
  if (!nearPos.length) return "";
  const list = nearPos.map((po) => `${po.poNumber} (${po.site ?? "no site"})`).join(", ");
  return `. This supplier's POs for that month: ${list}. Check the site.`;
}

/** The PO must fit the invoice: its number, same supplier, approved, same currency, site and month. */
function poMismatches(invoice: StandardInvoice, context: CheckContext, po: PurchaseOrder): (Finding | null)[] {
  const findings: (Finding | null)[] = [poNumberFinding(invoice, context, po)];
  if (context.supplier && po.supplierId && po.supplierId !== context.supplier.id) {
    findings.push({ status: "fail", text: `PO ${po.poNumber} belongs to another supplier (${po.supplierId})` });
  }
  if (!po.supplierId && po.supplierName && !isPoSupplier(po, invoice, context.supplier)) {
    const text = `PO ${po.poNumber} is for ${po.supplierName}, the invoice is from ${invoice.supplier.name}`;
    findings.push({ status: "fail", text });
  }
  // Exactly "APPROVED": "NOT APPROVED", "Unapproved", "Pending approval" are not.
  if (po.status && po.status.trim().toUpperCase() !== "APPROVED") {
    findings.push({ status: "fail", text: `PO ${po.poNumber} is ${po.status}, not approved` });
  }
  if (normId(po.currency) !== normId(invoice.currency)) {
    findings.push({ status: "fail", text: `Invoice is in ${invoice.currency}, PO is in ${po.currency}` });
  }
  findings.push(siteMismatch(invoice, po), monthMismatch(invoice, po));
  return findings;
}

/** Keyed POs: a note when it was found by site + month. Uploaded POs: the invoice should quote that PO's number. */
function poNumberFinding(invoice: StandardInvoice, context: CheckContext, po: PurchaseOrder): Finding | null {
  if (context.poFoundBy === "site and month") {
    return {
      status: "note",
      text:
        `No PO number on the invoice: matched to ${po.poNumber} by supplier, site and month. ` +
        "Ask the supplier to quote the PO number.",
    };
  }
  if (context.poFoundBy !== "uploaded" || !po.poNumber) return null;
  if (!invoice.poNumber) {
    return { status: "note", text: `The invoice doesn't quote PO ${po.poNumber}. Ask the supplier to quote it.` };
  }
  if (normId(invoice.poNumber) === normId(po.poNumber)) return null;
  return { status: "fail", text: `Invoice quotes PO ${invoice.poNumber}, but the PO uploaded is ${po.poNumber}` };
}

/** The PO's site must be the invoice's site, or the address on a signed service record attached to it. */
function siteMismatch(invoice: StandardInvoice, po: PurchaseOrder): Finding | null {
  if (!po.site || siteMatches(po.site, invoice)) return null;
  if (!invoice.site) return { status: "note", text: `Invoice shows no site; PO ${po.poNumber} is for ${po.site}` };
  return { status: "fail", text: `Invoice is for "${invoice.site}", PO ${po.poNumber} is for "${po.site}"` };
}

/** The invoice's site, or the site of any signed service record attached to it, is the PO's site. */
function siteMatches(poSite: string, invoice: StandardInvoice): boolean {
  const signedRecordSites = invoice.serviceRecords.filter((record) => record.signed).map((record) => record.site);
  return [invoice.site, ...signedRecordSites].some((site) => site !== null && sameSite(poSite, site));
}

/** The PO must cover the invoice's month: its month, or (recurring) its contract dates. */
function monthMismatch(invoice: StandardInvoice, po: PurchaseOrder): Finding | null {
  const { month, from } = monthOf(invoice);
  const outside = month ? notCovered(month, po) : null;
  if (!outside) return null;
  // Only the invoice date says which month: an invoice billed in arrears is dated the month after.
  if (from === "invoice date") {
    return { status: "note", text: `The invoice doesn't say which month it is for; it is dated ${month}, ${outside}` };
  }
  return { status: "fail", text: `Invoice is for ${month}, ${outside}` };
}

/** Why the PO doesn't cover this month, e.g. "PO GEN000073 starts 2026-11-05"; null when it does. */
function notCovered(month: string, po: PurchaseOrder): string | null {
  if (po.period) return po.period === month ? null : `PO ${po.poNumber} is for ${po.period}`;
  if (po.validFrom && month < po.validFrom.slice(0, MONTH_LENGTH)) return `PO ${po.poNumber} starts ${po.validFrom}`;
  if (po.validTo && month > po.validTo.slice(0, MONTH_LENGTH)) return `PO ${po.poNumber} ended ${po.validTo}`;
  return null;
}
