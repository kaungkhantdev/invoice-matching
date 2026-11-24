import { Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { config } from "../config.js";
import { monthOf, servicePeriodOf, type StandardInvoice } from "../invoice.schema.js";
import { D, digits, fmt, normId, round2, sameCompany, sameSite } from "../normalize.js";
import { bankAccounts, type PoLine, type PurchaseOrder, type SupplierRecord } from "../accounting/accounting.source.js";
import type { TextractRead } from "../reader/textract.reader.js";

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
  /** What Amazon Textract found on the same pages, to compare with the AI. */
  textract?: TextractRead | null;
  /** How the PO was found: by the PO number on the invoice, or (no number) by supplier + site + month. */
  poFoundBy?: PoFoundBy;
  /** With no PO number: how many keyed POs fit this supplier, site and month. */
  poCandidates?: number;
  /** With no PO number and none for this site: the supplier's POs for the same month (a hint for the reviewer). */
  sameMonthPos?: PurchaseOrder[];
  /** An earlier invoice in this batch, or a recorded one, already billed this PO. */
  poAlreadyBilledBy?: string | null;
}

export type PoFoundBy = "number" | "site and month" | null;

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
  po: { description: string; unitPrice: string | null; amount: string | null; orderedQty: string; receivedQty: string | null } | null;
  /** A free line (0.00) that isn't on the PO, e.g. a loaned dispenser: nothing to check. */
  free: boolean;
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

/** A description with a quantity repeated at its start ("12 Sign Jumbo Roll" for 12 units) also without it. */
function names(description: string, quantity: string): string[] {
  const q = quantity.trim();
  return q && description.startsWith(`${q} `) ? [description, description.slice(q.length).trim()] : [description];
}

/** Best similarity of an invoice line (as read, or without a repeated quantity) to a name. */
const lineSimilarity = (l: { description: string; quantity: string }, name: string) =>
  Math.max(...names(l.description, l.quantity).map((d) => similarity(d, name)));

/** Every word of `short` is in `long` ("HWSC EcoWash Pearl Creme -5L" is in "5 HWSC EcoWash Pearl Creme -5L (6 visits p.a.)"). */
const allWordsIn = (short: string, long: string) => {
  const S = words(short);
  const L = words(long);
  return S.size >= 2 && [...S].every((w) => L.has(w));
};

/** The site of the PO is the invoice's site, or the address on a signed service record attached to it. */
function siteMatches(poSite: string, inv: StandardInvoice): boolean {
  const sites = [inv.site, ...inv.serviceRecords.filter((r) => r.signed).map((r) => r.site)];
  return sites.some((x) => x !== null && sameSite(poSite, x));
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
    if (inv.otherInvoicesInFile.length > 0) {
      findings.push({
        status: "fail",
        text: `This file holds ${inv.otherInvoicesInFile.length} more invoice(s) (${inv.otherInvoicesInFile.join(", ")}): only ${inv.invoiceNumber} was read. Split the file, one invoice per file.`,
      });
    }
    const agreed = this.compareTextract(inv, ctx.textract ?? null, findings);
    const status = worst(findings);
    // The problems first; and unless something failed, also what Textract confirmed.
    const details = [...findings.map((f) => f.text), ...(status !== "fail" && agreed.length ? [`Textract agrees on ${agreed.join(", ")}`] : [])];
    return { id: 0, name: "Read clearly", status, details };
  }

  /**
   * Textract (OCR) and the AI must agree on the key fields they both found. Textract's fields come from its
   * own invoice model, separate from the AI's answer, so a misread number shows up here.
   * A field only one of them found isn't compared. Returns the fields they agreed on.
   */
  private compareTextract(inv: StandardInvoice, textract: TextractRead | null, findings: Finding[]): string[] {
    if (!textract) return [];
    // A page Textract couldn't read: say so, and still compare whatever it found on the other pages.
    if (textract.error) findings.push({ status: "note", text: `Textract couldn't read all of it, so the AI read that part alone: ${textract.error}` });
    if (textract.skippedPages > 0) {
      findings.push({ status: "note", text: `Textract read only the first ${textract.pages} of ${textract.pages + textract.skippedPages} pages (TEXTRACT_MAX_PAGES)` });
    }
    const agreed: string[] = [];
    const f = textract.fields;
    const sameId = (label: string, ai: (string | null)[], other: string | null) => {
      const known = ai.filter((v): v is string => Boolean(v));
      if (!known.length || !other) return;
      if (known.some((v) => normId(v) === normId(other))) agreed.push(label);
      else findings.push({ status: "fail", text: `${label}: the AI read "${known[0]}", Textract read "${other}"` });
    };
    /** `accepted`: every value the AI's own numbers allow (printed forms differ between suppliers). */
    const sameAmount = (label: string, accepted: Decimal[], other: string | null, onMismatch: CheckStatus = "fail") => {
      if (other === null) return;
      if (accepted.some((a) => round2(a).eq(round2(D(other))))) agreed.push(label);
      else findings.push({ status: onMismatch, text: `${label}: the AI read ${fmt(round2(accepted[0]))}, Textract read ${other}` });
    };

    sameId("invoice no.", [inv.invoiceNumber], f.invoiceNumber);
    sameId("PO", [inv.poNumber], f.poNumber);
    // Many Singapore invoices print the UEN as the GST number: either one counts.
    sameId("GST reg. no.", [inv.supplier.gstRegNo, inv.supplier.uen], f.gstRegNo);

    // A printed "Sub-total" may come before or after discounts and fees, and with or without GST.
    const subtotal = D(inv.subtotal);
    const afterAdjustments = subtotal.plus(inv.fees).minus(inv.discounts);
    const subtotals = [subtotal, afterAdjustments];
    if (inv.pricesIncludeTax) subtotals.push(subtotal.minus(inv.tax), afterAdjustments.minus(inv.tax));
    sameAmount("subtotal", subtotals, f.subtotal);
    sameAmount("GST", [D(inv.tax)], f.tax);
    // "Amount due" can differ from the total for good reasons (deposit paid, balance brought forward).
    sameAmount(f.totalFrom === "AMOUNT_DUE" ? "amount due" : "total", [D(inv.total)], f.total, f.totalFrom === "AMOUNT_DUE" ? "note" : "fail");
    return agreed;
  }

  // 1. Math adds up: qty × price = amount; lines = subtotal; subtotal + GST + fees − discounts = total; GST = 9%.
  private mathAddsUp(inv: StandardInvoice): CheckResult {
    const findings: (Finding | null)[] = [];
    const rate = config.gstRate;

    inv.lines.forEach((l, i) => {
      // Only when a unit price is printed (a monthly service charge has just an amount).
      if (l.unitPrice !== null) findings.push(compare(`Line ${i + 1} amount`, D(l.amount), D(l.quantity).times(l.unitPrice)));
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

  // 2. PO exists: billed to us; the PO is this supplier's, same currency, same site, same month.
  private poExists(inv: StandardInvoice, ctx: CheckContext): CheckResult {
    const findings: Finding[] = [];
    const done = () => ({ id: 2, name: "PO exists", status: worst(findings), details: findings.map((f) => f.text) });

    if (config.buyerNames.length) {
      if (!inv.billTo) findings.push({ status: "note", text: "Can't see who the invoice is billed to" });
      else if (!config.buyerNames.some((n) => sameCompany(n, inv.billTo!))) {
        findings.push({ status: "fail", text: `Billed to "${inv.billTo}", not to us` });
      }
    }

    const po = ctx.po;
    if (!po) {
      if (inv.poNumber) findings.push({ status: "fail", text: `PO ${inv.poNumber} not found` });
      else if ((ctx.poCandidates ?? 0) > 1) {
        findings.push({ status: "fail", text: `No PO number on the invoice, and ${ctx.poCandidates} POs fit this supplier, site and month` });
      } else {
        const near = (ctx.sameMonthPos ?? []).slice(0, 3).map((p) => `${p.poNumber} (${p.site ?? "no site"})`);
        findings.push({
          status: "fail",
          text: `No PO number on the invoice, and no PO for this supplier, site and month${inv.site ? ` (site read: "${inv.site}")` : ""}` +
            (near.length ? `. This supplier's POs for that month: ${near.join(", ")}. Check the site.` : ""),
        });
      }
      return done();
    }
    if (ctx.poFoundBy === "site and month") {
      findings.push({
        status: "note",
        text: `No PO number on the invoice: matched to ${po.poNumber} by supplier, site and month. Ask the supplier to quote the PO number.`,
      });
    }
    if (ctx.supplier && po.supplierId !== ctx.supplier.id) {
      findings.push({ status: "fail", text: `PO ${po.poNumber} belongs to another supplier (${po.supplierId})` });
    }
    if (normId(po.currency) !== normId(inv.currency)) {
      findings.push({ status: "fail", text: `Invoice is in ${inv.currency}, PO is in ${po.currency}` });
    }
    if (po.site && !siteMatches(po.site, inv)) {
      findings.push(
        inv.site
          ? { status: "fail", text: `Invoice is for "${inv.site}", PO ${po.poNumber} is for "${po.site}"` }
          : { status: "note", text: `Invoice shows no site; PO ${po.poNumber} is for ${po.site}` },
      );
    }
    const { month, from } = monthOf(inv);
    if (po.period && month && po.period !== month) {
      // Only the invoice date says which month: an invoice billed in arrears is dated the month after.
      findings.push(
        from === "invoice date"
          ? { status: "note", text: `The invoice doesn't say which month it is for; it is dated ${month}, PO ${po.poNumber} is for ${po.period}` }
          : { status: "fail", text: `Invoice is for ${month}, PO ${po.poNumber} is for ${po.period}` },
      );
    }
    return done();
  }

  /**
   * Pair each invoice line with the most similar PO line. Free lines (0.00: loaned dispensers, included refills)
   * are left unpaired: "Sign Jumbo Roll Tissue" must not be counted against the PO's "JRT Jumbo Roll 600g".
   */
  matchLines(inv: StandardInvoice, po: PurchaseOrder | null): (PoLine | null)[] {
    if (!po) return inv.lines.map(() => null);
    if (po.lines.length === 1 && inv.lines.length === 1) return [po.lines[0]];
    return inv.lines.map((l) => {
      if (D(l.amount).isZero()) return null;
      let best: PoLine | null = null;
      let bestScore = 0;
      for (const p of po.lines) {
        const score = lineSimilarity(l, p.description);
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

  /** Amount before GST (for invoices whose prices include GST). */
  private amountExTax(inv: StandardInvoice, amount: string): Decimal {
    const a = D(amount);
    return inv.pricesIncludeTax && D(inv.tax).gt(0) ? a.div(config.gstRate.plus(1)) : a;
  }

  /**
   * What a PO line allows for this quantity: quantity × unit price, or its amount for the ordered quantity shared
   * pro rata (6 bins for 21.60 → 4 bins 14.40; the same charge split over two lines adds up to 21.60, not 43.20).
   */
  private poAmount(p: PoLine, quantity: string): Decimal | null {
    if (p.amount != null) {
      const ordered = D(p.orderedQty);
      return ordered.isZero() ? D(p.amount) : D(p.amount).times(quantity).div(ordered);
    }
    if (p.unitPrice != null) return D(quantity).times(p.unitPrice);
    return null;
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
      const invoicePriceExTax = l.unitPrice === null ? null : round2(this.priceExTax(inv, l.unitPrice));
      const invoiceAmountExTax = round2(this.amountExTax(inv, l.amount));
      const base = {
        line: i + 1,
        description: l.description,
        quantity: l.quantity,
        invoicePriceExTax: invoicePriceExTax === null ? null : fmt(invoicePriceExTax),
        invoiceAmountExTax: fmt(invoiceAmountExTax),
      };
      if (!p) {
        // A free line (loaned dispenser, included refill) costs nothing: no need to be on the PO.
        const free = invoiceAmountExTax.isZero();
        return { ...base, po: null, poAllowed: null, free, priceStatus: free ? "pass" : "fail", priceEffect: null, qtyStatus: free ? "pass" : "fail", invoicedOnPoLine: null };
      }
      // The rounding allowance applies to what the difference costs on this line, not to the unit price:
      // 0.20 too much on 100 boxes is 20.00, not a rounding difference.
      const allowed = this.poAmount(p, l.quantity);
      let effect: Decimal | null;
      if (invoicePriceExTax !== null && p.unitPrice != null && p.amount == null) {
        effect = invoicePriceExTax.minus(round2(D(p.unitPrice))).abs().times(D(l.quantity).abs());
      } else {
        effect = allowed === null ? null : invoiceAmountExTax.minus(round2(allowed)).abs();
      }
      // Goods: no more than received. Services (no received qty on the PO): no more than ordered.
      const cap = p.receivedQty ?? p.orderedQty;
      const priceStatus: LineComparison["priceStatus"] = effect === null ? "fail" : effect.isZero() ? "pass" : effect.lte(config.tolerance) ? "note" : "fail";
      return {
        ...base,
        po: {
          description: p.description,
          unitPrice: p.unitPrice == null ? null : fmt(round2(D(p.unitPrice))),
          amount: p.amount == null ? null : fmt(round2(D(p.amount))),
          orderedQty: p.orderedQty,
          receivedQty: p.receivedQty ?? null,
        },
        poAllowed: allowed === null ? null : fmt(round2(allowed)),
        free: false,
        priceStatus,
        priceEffect: effect === null || effect.isZero() ? null : fmt(round2(effect)),
        qtyStatus: invoicedPerPoLine.get(p)!.gt(cap) ? "fail" : "pass",
        invoicedOnPoLine: invoicedPerPoLine.get(p)!.toString(),
      };
    });
  }

  // 3. Lines match the PO: same price, not more than received / ordered, and the delivery is proven.
  private linesMatch(inv: StandardInvoice, ctx: CheckContext): CheckResult {
    if (!ctx.po) return { id: 3, name: "Lines match PO", status: "skip", details: ["No PO to compare with"] };
    const findings: Finding[] = [];
    for (const row of this.compareLines(inv, ctx.po)) {
      const label = `Line ${row.line} "${row.description}"`;
      if (row.free) continue;
      if (!row.po) {
        findings.push({ status: "fail", text: `${label} is not on the PO` });
        continue;
      }
      if (row.priceStatus !== "pass") {
        const poSays = row.po.amount ?? row.po.unitPrice;
        findings.push({
          status: row.priceStatus,
          text:
            poSays === null
              ? `${label}: the PO line has no price`
              : row.invoicePriceExTax !== null && row.po.amount === null
                ? `${label} price: invoice says ${row.invoicePriceExTax}, PO says ${row.po.unitPrice} (${row.priceEffect} on ${row.quantity} units)`
                : `${label} amount: invoice says ${row.invoiceAmountExTax}, PO allows ${row.poAllowed} for ${row.quantity} (difference ${row.priceEffect})`,
        });
      }
      if (row.qtyStatus === "fail") {
        const total = row.invoicedOnPoLine !== row.quantity ? ` (${row.invoicedOnPoLine} in total on this invoice)` : "";
        findings.push({
          status: "fail",
          text: row.po.receivedQty !== null
            ? `${label}: invoiced ${row.quantity}${total}, but only ${row.po.receivedQty} received`
            : `${label}: invoiced ${row.quantity}${total}, but the PO has ${row.po.orderedQty}`,
        });
      }
    }
    findings.push(...this.serviceProof(inv, ctx.po, this.matchLines(inv, ctx.po)));
    return { id: 3, name: "Lines match PO", status: worst(findings), details: findings.map((f) => f.text) };
  }

  /**
   * Services (PO lines without a received qty) are proven by the service record attached to the invoice:
   * same site, same month, signed by us. Items it says weren't done but are billed get a note.
   */
  private serviceProof(inv: StandardInvoice, po: PurchaseOrder, matches: (PoLine | null)[]): Finding[] {
    // Only when the invoice bills a service line (a goods-only invoice is proven by the received quantities).
    if (!matches.some((p) => p !== null && p.receivedQty == null)) return [];
    const records = inv.serviceRecords;
    if (records.length === 0) return [{ status: "fail", text: "No signed service record (service report, card or delivery order) attached as proof" }];
    const findings: Finding[] = [];
    // A month known only from the invoice date is a guess (billed in arrears): the PO's month is better then.
    const known = monthOf(inv);
    const month = (known.from === "invoice date" ? po.period : known.month) ?? known.month ?? po.period ?? null;
    // A record may name the site ("SLC 1") or give its address: either the PO's or the invoice's site will do.
    const sites = [po.site, inv.site].filter((x): x is string => Boolean(x));
    const day = (r: (typeof records)[number]) => r.dates[0] ?? "undated";
    const inMonth = (r: (typeof records)[number]) => !month || r.dates.some((d) => d.startsWith(month));

    if (!records.some((r) => r.signed && inMonth(r))) {
      findings.push({ status: "fail", text: month ? `No signed service record dated in ${month}` : "No signed service record" });
    }
    for (const r of records) {
      if (sites.length && r.site && !sites.some((x) => sameSite(x, r.site!))) {
        findings.push({ status: "fail", text: `The ${r.kind} of ${day(r)} is for "${r.site}", not this site` });
      }
      if (!inMonth(r)) findings.push({ status: "note", text: `The ${r.kind} of ${day(r)} is not in ${month}` });
      else if (!r.signed) findings.push({ status: "note", text: `The ${r.kind} of ${day(r)} is not signed` });
      for (const entry of r.notDone) {
        // "HWSC EcoWash Pearl Creme -5L: No Stock": compare the item name, not the reason.
        const item = entry.split(":")[0].trim() || entry;
        // The best-matching charged line, not just the first similar one ("85 X 150 …" ≠ "60 X 85 …").
        let billed: StandardInvoice["lines"][number] | null = null;
        let bestScore = 0;
        for (const l of inv.lines) {
          if (!D(l.amount).gt(0)) continue;
          const sim = lineSimilarity(l, item);
          const contained = names(l.description, l.quantity).some((d) => allWordsIn(item, d));
          if (sim < config.lineMatchMinScore && !contained) continue;
          const score = sim + (contained ? 0.5 : 0);
          if (score > bestScore) [billed, bestScore] = [l, score];
        }
        if (billed) findings.push({ status: "note", text: `"${billed.description}" is billed, but the ${r.kind} of ${day(r)} says not done: ${entry}` });
      }
    }
    return findings;
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
    // Free lines (0.00) don't need to be on the PO.
    if (matches.some((m, i) => m === null && !D(inv.lines[i].amount).isZero())) {
      findings.push({ status: "skip", text: "Some lines are not on the PO" });
      return { id: 4, name, status: worst(findings, "skip"), details: findings.map((f) => f.text) };
    }
    const allowed = inv.lines.map((l, i) => (matches[i] ? this.poAmount(matches[i]!, l.quantity) : D(0)));
    if (allowed.some((a) => a === null)) {
      findings.push({ status: "skip", text: "Some PO lines have no price" });
      return { id: 4, name, status: worst(findings, "skip"), details: findings.map((f) => f.text) };
    }
    const expected = allowed.reduce<Decimal>((sum, a) => sum.plus(a!), D(0));
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
    let status: CheckStatus = details.length ? "fail" : "pass";
    if (ctx.poAlreadyBilledBy && ctx.po) {
      // A service PO (lines without received qty) is billed once. A goods PO may be billed in parts: a note.
      details.push(`PO ${ctx.po.poNumber}${ctx.po.period ? ` (${ctx.po.period})` : ""} is already billed by ${ctx.poAlreadyBilledBy}`);
      if (ctx.po.lines.some((l) => l.receivedQty == null)) status = "fail";
      else if (status === "pass") status = "note";
    }
    return { id: 5, name: "Not a duplicate", status, details };
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
    const onFile = bankAccounts(s);
    if (invoiceAccount && !onFile.some((a) => digits(a) === digits(invoiceAccount))) {
      findings.push({
        status: "fail",
        text: `Bank account on invoice (${invoiceAccount}) is NOT the one on file (${onFile.join(" or ")}). Confirm with the supplier using the phone number on file before paying.`,
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
