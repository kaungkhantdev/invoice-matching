import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupplierRecord } from "../src/matching/accounting/accounting.source.js";
import type { StandardInvoice } from "../src/matching/invoice.schema.js";
import type { InvoiceResult } from "../src/matching/matching.service.js";
import type { Entry } from "../src/invoices/invoice-store.service.js";
import { reviewOf, toSummary } from "../src/invoices/invoice.view.js";

const supplier: SupplierRecord = {
  id: "SUP-1",
  name: "Rentokil Initial Singapore Pte Ltd",
  uen: "197200078R",
  gstRegNo: "M2-0003672-0",
  bankAccountNumber: ["003-900111-1", "0721-234567"],
};

const invoice = (change: Partial<StandardInvoice["supplier"]> = {}, account = "0039001111"): StandardInvoice => ({
  documentType: "tax_invoice",
  supplier: { name: supplier.name, uen: "197200078-R", gstRegNo: "m2 0003672 0", address: null, ...change },
  bank: { accountHolder: null, accountNumber: account, swift: null },
  invoiceNumber: "0021490975",
  invoiceDate: "2026-10-31",
  dueDate: null,
  poNumber: null,
  currency: "SGD",
  pricesIncludeTax: false,
  lines: [],
  subtotal: "0",
  tax: "0",
  fees: "0",
  discounts: "0",
  total: "0",
  uncertainFields: [],
  billTo: "Industrial & Commercial Facilities Management Pte Ltd",
  site: null,
  servicePeriod: "2026-10",
  serviceRecords: [
    { kind: "service report", dates: ["2026-10-30"], site: null, signed: true, notDone: ["EcoWash"] },
    { kind: "service card", dates: ["2026-10-16"], site: null, signed: false, notDone: [] },
  ],
  otherInvoicesInFile: [],
});

const result = (inv: StandardInvoice, s: SupplierRecord | null = supplier): InvoiceResult => ({
  file: "a.pdf",
  outcome: "MATCHED",
  readBy: "bedrock",
  model: "m",
  invoice: inv,
  checks: [
    { id: 1, name: "Math", status: "pass", details: [] },
    { id: 2, name: "PO exists", status: "skip", details: [] },
    { id: 6, name: "Supplier is real", status: "fail", details: [] },
  ],
  error: null,
  context: { supplier: s, po: null, poFoundBy: null, month: { value: "2026-10", from: "stated" }, lines: [] },
  invoiceKey: null,
});

describe("what the page shows (worked out in the API)", () => {
  it("same UEN, GST no. and one of two bank accounts, written differently → nothing red", () => {
    const r = reviewOf(result(invoice()))!;
    assert.deepEqual(r.onFile.uen, { onFile: "197200078R", differs: false });
    assert.deepEqual(r.onFile.gstRegNo, { onFile: "M2-0003672-0", differs: false });
    assert.deepEqual(r.onFile.bank, { onFile: "003-900111-1 or 0721-234567", differs: false });
  });

  it("another bank account, or a GST no. for a supplier not registered → red", () => {
    assert.equal(reviewOf(result(invoice({}, "111-222333-4")))!.onFile.bank.differs, true);
    const r = reviewOf(result(invoice(), { ...supplier, gstRegNo: null }))!;
    assert.deepEqual(r.onFile.gstRegNo, { onFile: "not GST-registered", differs: true });
  });

  it("unknown supplier → nothing to compare with", () => {
    const r = reviewOf(result(invoice(), null))!;
    assert.deepEqual(r.onFile.uen, { onFile: null, differs: false });
    assert.deepEqual(r.onFile.bank, { onFile: null, differs: false });
  });

  it("read but not checked yet → still 'reading' (never a short 'Review'); Review counts until decided", () => {
    const entry = { id: "1", seq: 1, file: "a.pdf", state: "DONE", result: null, read: null, attempts: 1, retryError: null, decision: null, updatedAt: 0 };
    const reading = toSummary(entry as unknown as Entry);
    assert.deepEqual([reading.state, reading.outcome, reading.needsReview], ["READING", null, false]);
    const review = { ...result(invoice()), outcome: "REVIEW" as const };
    assert.equal(toSummary({ ...entry, result: review } as unknown as Entry).needsReview, true);
    const decided = { ...entry, result: review, decision: { status: "APPROVED", note: "", at: "", outcome: "REVIEW" } };
    assert.equal(toSummary(decided as unknown as Entry).needsReview, false);
  });

  it("service proof and the match summary counts", () => {
    const r = reviewOf(result(invoice()))!;
    assert.equal(r.serviceProof, "2 records · 1 signed · 2026-10-16 to 2026-10-30 · not done: EcoWash");
    assert.deepEqual([r.checksPassed, r.checks, r.linesMatched, r.lines], [1, 2, 0, 0]);
  });
});
