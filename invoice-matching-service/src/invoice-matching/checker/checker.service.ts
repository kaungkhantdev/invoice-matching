import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { config } from "../config.js";
import type { StandardInvoice } from "../invoice.schema.js";
import { D, digits, fmt, normId, round2 } from "../normalize.js";
import type { PoLine, PurchaseOrder, SupplierRecord } from "../accounting/accounting.source.js";

export type CheckStatus = "pass" | "note" | "fail" | "skip";
export type Outcome = "MATCHED" | "MATCHED_WITH_NOTE" | "REVIEW";

export interface CheckResult {
  id: number;
  name: string;
  status: CheckStatus;
  details: string[];
}

export interface CheckContext {
  supplier: SupplierRecord | null;
  po: PurchaseOrder | null;
  alreadyRecorded: boolean;
  /** File name of an earlier copy of this invoice in the same batch, if any. */
  duplicateInBatch: string | null;
  /** Problems found while cleaning the data the reader returned. */
  readProblems: string[];
}

/** One invoice line next to its PO line, for check 3 and the review page. */
export interface LineComparison {
  line: number;
  description: string;
  quantity: string;
  /** Invoice unit price before GST, rounded to cents. */
  invoicePriceExTax: string;
  po: { description: string; unitPrice: string; orderedQty: string; receivedQty: string } | null;
  priceStatus: "pass" | "note" | "fail";
  /** What the price difference costs on this line (qty × difference), or null if the price matches. */
  priceEffect: string | null;
  qtyStatus: "pass" | "fail";
  /** All invoiced quantity for this PO line (several invoice lines can share one PO line). */
  invoicedOnPoLine: string | null;
}

interface Finding {
  status: CheckStatus;
  text: string;
}

const RANK: Record<CheckStatus, number> = { skip: 0, pass: 1, note: 2, fail: 3 };

function worst(findings: Finding[], whenEmpty: CheckStatus = "pass"): CheckStatus {
  return findings.reduce<CheckStatus>((w, f) => (RANK[f.status] > RANK[w] ? f.status : w), whenEmpty);
}

/** Same amount → pass, small difference → note, big difference → fail. */
function compare(label: string, actual: Decimal, expected: Decimal): Finding | null {
  const want = round2(expected);
  const diff = actual.minus(want).abs();
  if (diff.isZero()) return null;
  const text = `${label}: invoice says ${fmt(actual)}, should be ${fmt(want)} (difference ${fmt(diff)})`;
  return { status: diff.lte(config.tolerance) ? "note" : "fail", text };
}

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter((w) => w.length > 1 || /\d/.test(w)),
  );
}

/** 0–1: how many words two descriptions share. */
export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}

/**
 * The 6 checks (plus "read clearly"). Plain rules, no AI, so every result can be explained.
 */
@Injectable()
export class CheckerService {
  run(inv: StandardInvoice, ctx: CheckContext): CheckResult[] {
    const lineMatches = this.matchLines(inv, ctx.po);
    return [
      this.readClearly(inv, ctx),
      this.mathAddsUp(inv),
      this.poExists(inv, ctx),
      this.linesMatch(inv, ctx),
      this.totalMatchesPo(inv, ctx, lineMatches),
      this.notDuplicate(inv, ctx),
      this.supplierIsReal(inv, ctx),
    ];
  }

  outcome(checks: CheckResult[]): Outcome {
    const statuses = checks.map((c) => c.status);
    if (statuses.includes("fail")) return "REVIEW";
    if (statuses.includes("note")) return "MATCHED_WITH_NOTE";
    return "MATCHED";
  }

  // 0. Did we read the document clearly, and is it really an invoice?
  private readClearly(inv: StandardInvoice, ctx: CheckContext): CheckResult {
    const findings: Finding[] = ctx.readProblems.map((text) => ({ status: "fail", text }));
    if (!["tax_invoice", "invoice"].includes(inv.documentType)) {
      findings.push({ status: "fail", text: `This is a ${inv.documentType.replace("_", " ")}, not an invoice` });
    }
    if (inv.uncertainFields.length > 0) {
      findings.push({ status: "fail", text: `Reader wasn't sure about: ${inv.uncertainFields.join(", ")}` });
    }
    return { id: 0, name: "Read clearly", status: worst(findings), details: findings.map((f) => f.text) };
  }

  // 1. Math adds up: qty × price = amount; lines = subtotal; subtotal + GST + fees − discounts = total; GST = 9%.
  private mathAddsUp(inv: StandardInvoice): CheckResult {
    const findings: (Finding | null)[] = [];
    const rate = config.gstRate;

    inv.lines.forEach((l, i) => {
      findings.push(compare(`Line ${i + 1} amount`, D(l.amount), D(l.quantity).times(l.unitPrice)));
    });

    const linesSum = inv.lines.reduce((sum, l) => sum.plus(l.amount), D(0));
    findings.push(compare("Subtotal", D(inv.subtotal), linesSum));

    const subtotal = D(inv.subtotal);
    const tax = D(inv.tax);
    const fees = D(inv.fees);
    const discounts = D(inv.discounts);
    const base = subtotal.plus(fees).minus(discounts);

    if (inv.pricesIncludeTax) {
      findings.push(compare("Total", D(inv.total), base));
      if (tax.gt(0)) findings.push(compare("GST", tax, base.times(rate).div(rate.plus(1))));
    } else {
      findings.push(compare("Total", D(inv.total), base.plus(tax)));
      if (tax.gt(0)) findings.push(compare(`GST (${rate.times(100)}%)`, tax, base.times(rate)));
    }

    const real = findings.filter((f): f is Finding => f !== null);
    return { id: 1, name: "Math adds up", status: worst(real), details: real.map((f) => f.text) };
  }

  // 2. PO exists, belongs to this supplier, same currency.
  private poExists(inv: StandardInvoice, ctx: CheckContext): CheckResult {
    const fail = (text: string): CheckResult => ({ id: 2, name: "PO exists", status: "fail", details: [text] });
    if (!inv.poNumber) return fail("No PO number on the invoice");
    if (!ctx.po) return fail(`PO ${inv.poNumber} not found`);
    if (ctx.supplier && ctx.po.supplierId !== ctx.supplier.id) {
      return fail(`PO ${ctx.po.poNumber} belongs to another supplier (${ctx.po.supplierId})`);
    }
    if (normId(ctx.po.currency) !== normId(inv.currency)) {
      return fail(`Invoice is in ${inv.currency}, PO is in ${ctx.po.currency}`);
    }
    return { id: 2, name: "PO exists", status: "pass", details: [] };
  }

  /** Pair each invoice line with the most similar PO line. */
  matchLines(inv: StandardInvoice, po: PurchaseOrder | null): (PoLine | null)[] {
    if (!po) return inv.lines.map(() => null);
    if (po.lines.length === 1 && inv.lines.length === 1) return [po.lines[0]];
    return inv.lines.map((l) => {
      let best: PoLine | null = null;
      let bestScore = 0;
      for (const p of po.lines) {
        const score = similarity(l.description, p.description);
        if (score > bestScore) {
          best = p;
          bestScore = score;
        }
      }
      return bestScore >= config.lineMatchMinScore ? best : null;
    });
  }

  /** Unit price before GST, so it can be compared with the PO price. */
  private priceExTax(inv: StandardInvoice, unitPrice: string): Decimal {
    const price = D(unitPrice);
    return inv.pricesIncludeTax && D(inv.tax).gt(0) ? price.div(config.gstRate.plus(1)) : price;
  }

  /**
   * Each invoice line next to the PO line it was paired with: price and quantity, each with a status.
   * Check 3 and the review page both use this, so they always agree.
   */
  compareLines(inv: StandardInvoice, po: PurchaseOrder | null): LineComparison[] {
    const matches = this.matchLines(inv, po);
    // Several invoice lines can belong to the same PO line: compare their TOTAL with what was received.
    const invoicedPerPoLine = new Map<PoLine, Decimal>();
    inv.lines.forEach((l, i) => {
      const p = matches[i];
      if (p) invoicedPerPoLine.set(p, (invoicedPerPoLine.get(p) ?? D(0)).plus(l.quantity));
    });
    return inv.lines.map((l, i) => {
      const p = matches[i];
      const invoicePriceExTax = round2(this.priceExTax(inv, l.unitPrice));
      if (!p) {
        return {
          line: i + 1,
          description: l.description,
          quantity: l.quantity,
          invoicePriceExTax: fmt(invoicePriceExTax),
          po: null,
          priceStatus: "fail",
          priceEffect: null,
          qtyStatus: "fail",
          invoicedOnPoLine: null,
        };
      }
      // The rounding allowance applies to what the price difference costs on this line (qty × difference),
      // not to the unit price: 0.20 too much on 100 boxes is 20.00, not a rounding difference.
      const poPrice = round2(D(p.unitPrice));
      const effect = invoicePriceExTax.minus(poPrice).abs().times(D(l.quantity).abs());
      return {
        line: i + 1,
        description: l.description,
        quantity: l.quantity,
        invoicePriceExTax: fmt(invoicePriceExTax),
        po: { description: p.description, unitPrice: fmt(poPrice), orderedQty: p.orderedQty, receivedQty: p.receivedQty },
        priceStatus: effect.isZero() ? "pass" : effect.lte(config.tolerance) ? "note" : "fail",
        priceEffect: effect.isZero() ? null : fmt(round2(effect)),
        qtyStatus: invoicedPerPoLine.get(p)!.gt(p.receivedQty) ? "fail" : "pass",
        invoicedOnPoLine: invoicedPerPoLine.get(p)!.toString(),
      };
    });
  }

  // 3. Lines match the PO: same price, and not more than we received (3-way match).
  private linesMatch(inv: StandardInvoice, ctx: CheckContext): CheckResult {
    if (!ctx.po) return { id: 3, name: "Lines match PO", status: "skip", details: ["No PO to compare with"] };
    const findings: Finding[] = [];
    for (const row of this.compareLines(inv, ctx.po)) {
      const label = `Line ${row.line} "${row.description}"`;
      if (!row.po) {
        findings.push({ status: "fail", text: `${label} is not on the PO` });
        continue;
      }
      if (row.priceStatus !== "pass") {
        findings.push({
          status: row.priceStatus,
          text: `${label} price: invoice says ${row.invoicePriceExTax}, PO says ${row.po.unitPrice} (${row.priceEffect} on ${row.quantity} units)`,
        });
      }
      if (row.qtyStatus === "fail") {
        const total = row.invoicedOnPoLine !== row.quantity ? ` (${row.invoicedOnPoLine} in total on this invoice)` : "";
        findings.push({ status: "fail", text: `${label}: invoiced ${row.quantity}${total}, but only ${row.po.receivedQty} received` });
      }
    }
    return { id: 3, name: "Lines match PO", status: worst(findings), details: findings.map((f) => f.text) };
  }

  // 4. Invoice subtotal = invoiced quantities × PO prices.
  private totalMatchesPo(inv: StandardInvoice, ctx: CheckContext, matches: (PoLine | null)[]): CheckResult {
    const name = "Total matches PO";
    if (!ctx.po) return { id: 4, name, status: "skip", details: ["No PO to compare with"] };
    const findings: Finding[] = [];
    // Extra charges (delivery, surcharge…) are never on the PO: a person must agree to them.
    const fees = D(inv.fees);
    if (fees.gt(0)) {
      findings.push({
        status: fees.lte(config.tolerance) ? "note" : "fail",
        text: `Fees of ${fmt(fees)} are not on the PO`,
      });
    }
    if (matches.some((m) => m === null)) {
      findings.push({ status: "skip", text: "Some lines are not on the PO" });
      return { id: 4, name, status: worst(findings, "skip"), details: findings.map((f) => f.text) };
    }
    const expected = inv.lines.reduce((sum, l, i) => sum.plus(D(l.quantity).times(matches[i]!.unitPrice)), D(0));
    // Same conversion as the unit prices: GST-inclusive amounts ÷ (1 + rate).
    const subtotalExTax =
      inv.pricesIncludeTax && D(inv.tax).gt(0) ? round2(D(inv.subtotal).div(config.gstRate.plus(1))) : D(inv.subtotal);
    const f = compare("Subtotal at PO prices", subtotalExTax, expected);
    if (f) findings.push(f);
    return { id: 4, name, status: worst(findings), details: findings.map((x) => x.text) };
  }

  // 5. Not a duplicate.
  private notDuplicate(inv: StandardInvoice, ctx: CheckContext): CheckResult {
    const details: string[] = [];
    if (ctx.alreadyRecorded) details.push(`Invoice ${inv.invoiceNumber} from this supplier is already recorded`);
    if (ctx.duplicateInBatch) details.push(`Same invoice as ${ctx.duplicateInBatch} in this batch`);
    return { id: 5, name: "Not a duplicate", status: details.length ? "fail" : "pass", details };
  }

  // 6. Supplier is real: known supplier, same bank account as on file, valid GST registration.
  private supplierIsReal(inv: StandardInvoice, ctx: CheckContext): CheckResult {
    const name = "Supplier is real";
    const s = ctx.supplier;
    if (!s) {
      return { id: 6, name, status: "fail", details: [`"${inv.supplier.name}" is not on our supplier list`] };
    }
    const findings: Finding[] = [];

    if (inv.supplier.uen && s.uen && normId(inv.supplier.uen) !== normId(s.uen)) {
      findings.push({ status: "fail", text: `UEN on invoice (${inv.supplier.uen}) differs from the one on file (${s.uen})` });
    }

    const invoiceAccount = inv.bank.accountNumber;
    if (invoiceAccount && digits(invoiceAccount) !== digits(s.bankAccountNumber)) {
      findings.push({
        status: "fail",
        text: `Bank account on invoice (${invoiceAccount}) is NOT the one on file (${s.bankAccountNumber}). Confirm with the supplier using the phone number on file before paying.`,
      });
    }

    const tax = D(inv.tax);
    if (tax.gt(0)) {
      if (!s.gstRegNo) {
        findings.push({ status: "fail", text: "Charges GST, but the supplier is not GST-registered on file" });
      } else if (!inv.supplier.gstRegNo) {
        findings.push({ status: "fail", text: "Charges GST, but no GST registration no. on the invoice" });
      } else if (normId(inv.supplier.gstRegNo) !== normId(s.gstRegNo)) {
        findings.push({
          status: "fail",
          text: `GST reg. no. on invoice (${inv.supplier.gstRegNo}) differs from the one on file (${s.gstRegNo})`,
        });
      }
    } else if (s.gstRegNo) {
      findings.push({ status: "note", text: "Supplier is GST-registered but charged no GST. Check if it's zero-rated." });
    }

    return { id: 6, name, status: worst(findings), details: findings.map((f) => f.text) };
  }
}
