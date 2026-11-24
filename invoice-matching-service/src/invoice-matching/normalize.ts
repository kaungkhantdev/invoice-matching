import { Decimal } from "decimal.js";
import type { StandardInvoice } from "./invoice.schema.js";

export const D = (v: string | number) => new Decimal(v);

/** Round to cents, half-up (how GST and invoice totals are normally rounded). */
export const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Show an amount with at least 2 decimals, keeping extra decimals if a unit price has them. */
export const fmt = (d: Decimal) => d.toFixed(Math.max(2, d.decimalPlaces()));

/** "S$1,234.50" → "1234.50", "(20.00)" → "-20.00", "" → "0". Returns null if it isn't a number. */
export function cleanAmount(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === "" || s === "-") return "0";
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[A-Za-z$€£¥\s,]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return (negative ? "-" : "") + s;
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** Uppercase letters and digits only, for comparing IDs ("PO 2026/0101" ≈ "po-2026-0101"). */
export const normId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Digits only, for comparing bank account numbers. */
export const digits = (s: string) => s.replace(/\D/g, "");

/** Address short forms, so "2 Changi South St 2" = "2 Changi South Street 2". */
const ADDRESS_ABBR: Record<string, string> = {
  st: "street", rd: "road", ave: "avenue", av: "avenue", cres: "crescent", dr: "drive", ctr: "centre", center: "centre",
  ind: "industrial", bldg: "building", jln: "jalan", lor: "lorong", tce: "terrace", cl: "close", ln: "lane", sq: "square",
  pk: "park", nth: "north", sth: "south", upp: "upper", pl: "place", bt: "bukit", tg: "tanjong", kg: "kampong",
};
/** Words that say nothing about which site it is ("Blk", "No", "#", company forms). */
const ADDRESS_NOISE = new Set(["blk", "block", "no", "unit", "level", "lvl", "singapore", "sg", "pte", "ltd"]);
/** A Singapore postal code: 6 digits, also when written "S486759" or "Singapore486759". */
const POSTAL = /(?<!\d)\d{6}(?!\d)/g;

/**
 * Same site? Singapore postal codes decide when both addresses have one. Otherwise every number of the shorter
 * address (house, street, unit) must be in the longer one, as many times as it appears, and nearly all its words too
 * ("2 Changi South Street 2" = "SLC 1, 2 Changi South Street 2"; but not "8 Changi South Street 2", nor "No 5 …").
 */
export function sameSite(a: string, b: string): boolean {
  const postal = (s: string): string[] => s.match(POSTAL) ?? [];
  const [pa, pb] = [postal(a), postal(b)];
  if (pa.length && pb.length) return pa.some((p) => pb.includes(p));
  const parts = (s: string) => {
    const tokens = s
      .toLowerCase()
      .replace(/s?(?<!\d)\d{6}(?!\d)/gi, " ")
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((t) => ADDRESS_ABBR[t] ?? t)
      .filter((t) => !ADDRESS_NOISE.has(t));
    return { nums: tokens.filter((t) => /\d/.test(t)), words: new Set(tokens.filter((t) => !/\d/.test(t))) };
  };
  const [x, y] = [parts(a), parts(b)].sort((p, q) => p.words.size + p.nums.length - (q.words.size + q.nums.length));
  if (x.words.size === 0) return false;
  const pool = [...y.nums];
  for (const n of x.nums) {
    const i = pool.indexOf(n);
    if (i < 0) return false;
    pool.splice(i, 1);
  }
  const shared = [...x.words].filter((w) => y.words.has(w)).length;
  return shared / x.words.size >= 0.8;
}

const COMPANY_NOISE = new Set(["pte", "private", "ltd", "limited", "pl", "llp", "inc", "co", "company", "the"]);
const COMPANY_ABBR: Record<string, string> = { mgt: "management", mgmt: "management", mgm: "management" };
const companyWords = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/&/g, " and ")
      .split(/[^a-z0-9]+/)
      .map((w) => COMPANY_ABBR[w] ?? w)
      .filter((w) => w && !COMPANY_NOISE.has(w)),
  );

/** Same company, allowing the usual short forms ("Facilities Mgm Pte Ltd" = "Facilities Management"). */
export function sameCompany(a: string, b: string): boolean {
  const [A, B] = [companyWords(a), companyWords(b)];
  if (A.size === 0 || B.size === 0) return false;
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / Math.min(A.size, B.size) >= 0.8;
}

/**
 * Clean what a reader returned so the checks can trust the format.
 * Anything that can't be cleaned is listed in `problems` (→ the invoice goes to review).
 */
export function normalizeInvoice(raw: StandardInvoice): { invoice: StandardInvoice; problems: string[] } {
  const problems: string[] = [];

  const amount = (label: string, value: string, absolute = false): string => {
    const cleaned = cleanAmount(value);
    if (cleaned === null) {
      problems.push(`${label} is not a number: "${value}"`);
      return "0";
    }
    return absolute ? D(cleaned).abs().toString() : cleaned;
  };

  const date = (label: string, value: string | null): string | null => {
    if (value == null || value.trim() === "") return null;
    const v = value.trim();
    if (!isIsoDate(v)) {
      problems.push(`${label} is not a valid date: "${value}"`);
      return null;
    }
    return v;
  };

  const currency = raw.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`Currency is not a 3-letter code: "${raw.currency}"`);

  const invoiceNumber = raw.invoiceNumber.trim();
  if (invoiceNumber === "") problems.push("Invoice number is missing");

  const lines = raw.lines.map((l, i) => ({
    description: l.description.trim(),
    // A blank quantity is not "0": the reader missed it (e.g. left it in the description).
    quantity: l.quantity.trim() === "" ? (problems.push(`Line ${i + 1} quantity is missing`), "0") : amount(`Line ${i + 1} quantity`, l.quantity),
    // null = only an amount is printed (e.g. a monthly service charge).
    unitPrice: l.unitPrice == null || l.unitPrice.trim() === "" ? null : amount(`Line ${i + 1} unit price`, l.unitPrice),
    amount: amount(`Line ${i + 1} amount`, l.amount),
  }));
  if (lines.length === 0) problems.push("No line items found");

  const trimOrNull = (s: string | null) => (s == null || s.trim() === "" ? null : s.trim());
  /** An address or name printed over several lines → one line ("Siglap Centre, 55 Siglap Centre, Singapore …"). */
  const oneLine = (s: string | null) => trimOrNull(s?.replace(/\s*\n\s*/g, ", ") ?? null);

  // "2026-10" (a "2026-10-27" is cut to the month). Results saved before this field existed have none.
  const rawPeriod = trimOrNull(raw.servicePeriod ?? null);
  let servicePeriod: string | null = null;
  if (rawPeriod) {
    if (/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(rawPeriod)) servicePeriod = rawPeriod.slice(0, 7);
    else problems.push(`Service month is not YYYY-MM: "${rawPeriod}"`);
  }
  // Proof attached in the file. A date that isn't a real date is left out (the record then shows fewer dates).
  const serviceRecords = (raw.serviceRecords ?? []).map((r) => ({
    kind: r.kind.trim(),
    site: oneLine(r.site),
    dates: r.dates.map((d) => d.trim()).filter(isIsoDate),
    signed: r.signed,
    notDone: r.notDone.map((x) => x.trim()).filter(Boolean),
  }));

  const subtotal = amount("Subtotal", raw.subtotal);
  const tax = amount("GST", raw.tax);
  const fees = amount("Fees", raw.fees);
  const discounts = amount("Discounts", raw.discounts, true);
  const total = amount("Total", raw.total);

  return {
    problems,
    invoice: {
      ...raw,
      pricesIncludeTax: pricesIncludeTaxFromNumbers(raw.pricesIncludeTax, subtotal, tax, fees, discounts, total),
      supplier: {
        name: raw.supplier.name.trim(),
        uen: trimOrNull(raw.supplier.uen),
        gstRegNo: trimOrNull(raw.supplier.gstRegNo),
        address: trimOrNull(raw.supplier.address),
      },
      bank: {
        accountHolder: trimOrNull(raw.bank.accountHolder),
        accountNumber: trimOrNull(raw.bank.accountNumber),
        swift: trimOrNull(raw.bank.swift),
      },
      billTo: oneLine(raw.billTo ?? null),
      site: oneLine(raw.site ?? null),
      servicePeriod,
      serviceRecords,
      otherInvoicesInFile: (raw.otherInvoicesInFile ?? []).map((n) => n.trim()).filter(Boolean),
      invoiceNumber,
      invoiceDate: date("Invoice date", raw.invoiceDate),
      dueDate: date("Due date", raw.dueDate),
      poNumber: trimOrNull(raw.poNumber),
      currency,
      lines,
      subtotal,
      tax,
      fees,
      discounts,
      total,
    },
  };
}

/**
 * Whether line prices already include GST, worked out from the totals instead of trusting the reader:
 *   GST added on top:  subtotal + GST + fees − discounts = total
 *   GST included:      subtotal       + fees − discounts = total
 * If exactly one of these adds up, that's the answer. Otherwise keep what the reader said.
 */
export function pricesIncludeTaxFromNumbers(
  readerSaid: boolean,
  subtotal: string,
  tax: string,
  fees: string,
  discounts: string,
  total: string,
): boolean {
  if (D(tax).isZero()) return false;
  const close = (a: Decimal, b: Decimal) => a.minus(b).abs().lte("0.05");
  const base = D(subtotal).plus(fees).minus(discounts);
  const addedOnTop = close(base.plus(tax), D(total));
  const included = close(base, D(total));
  if (addedOnTop && !included) return false;
  if (included && !addedOnTop) return true;
  return readerSaid;
}
