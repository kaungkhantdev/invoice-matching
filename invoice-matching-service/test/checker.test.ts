import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PurchaseOrder, SupplierRecord } from "../src/invoice-matching/accounting/accounting.source.js";
import { CheckerService, type CheckContext } from "../src/invoice-matching/checker/checker.service.js";
import type { StandardInvoice } from "../src/invoice-matching/invoice.schema.js";

const supplier: SupplierRecord = {
  id: "SUP-001",
  name: "Orchid Garden Supplies Pte. Ltd.",
  uen: "201912345K",
  gstRegNo: "201912345K",
  bankAccountNumber: "072-123456-7",
};

const po: PurchaseOrder = {
  poNumber: "PO-1",
  supplierId: "SUP-001",
  currency: "SGD",
  lines: [
    { description: "Red rose stems (box of 50)", unitPrice: "85.00", orderedQty: "10", receivedQty: "10" },
    { description: "Eucalyptus bunch", unitPrice: "12.00", orderedQty: "20", receivedQty: "20" },
  ],
};

// 10 × 85 + 20 × 12 = 1090.00; GST 9% = 98.10; total 1188.10
function invoice(change: (i: StandardInvoice) => void = () => {}): StandardInvoice {
  const inv: StandardInvoice = {
    documentType: "tax_invoice",
    supplier: { name: supplier.name, uen: "201912345K", gstRegNo: "201912345K", address: null },
    bank: { accountHolder: null, accountNumber: "0721234567", swift: "DBSSSGSG" },
    invoiceNumber: "INV-1",
    invoiceDate: "2026-11-03",
    dueDate: "2026-12-03",
    poNumber: "PO-1",
    currency: "SGD",
    pricesIncludeTax: false,
    lines: [
      { description: "Red rose stems box of 50", quantity: "10", unitPrice: "85.00", amount: "850.00" },
      { description: "Eucalyptus (bunch)", quantity: "20", unitPrice: "12.00", amount: "240.00" },
    ],
    subtotal: "1090.00",
    tax: "98.10",
    fees: "0",
    discounts: "0",
    total: "1188.10",
    uncertainFields: [], billTo: "Industrial & Commercial Facilities Management Pte Ltd", site: null, servicePeriod: null, serviceRecords: [], otherInvoicesInFile: [],
  };
  change(inv);
  return inv;
}

const ctx = (change: Partial<CheckContext> = {}): CheckContext => ({
  supplier,
  po,
  alreadyRecorded: false,
  duplicateInBatch: null,
  readProblems: [],
  ...change,
});

const checker = new CheckerService();
const run = (inv: StandardInvoice, c: CheckContext = ctx()) => {
  const checks = checker.run(inv, c);
  return { outcome: checker.outcome(checks), failed: checks.filter((x) => x.status === "fail").map((x) => x.id), checks };
};

describe("checker", () => {
  it("clean invoice → MATCHED", () => {
    const r = run(invoice());
    assert.equal(r.outcome, "MATCHED", JSON.stringify(r.checks, null, 2));
  });

  it("total off by 0.40 (rounding) → MATCHED_WITH_NOTE", () => {
    const r = run(invoice((i) => (i.total = "1188.50")));
    assert.equal(r.outcome, "MATCHED_WITH_NOTE");
  });

  it("total off by 50 → REVIEW on check 1 (math)", () => {
    const r = run(invoice((i) => (i.total = "1238.10")));
    assert.equal(r.outcome, "REVIEW");
    assert.deepEqual(r.failed, [1]);
  });

  it("no PO number → REVIEW on check 2", () => {
    const r = run(invoice((i) => (i.poNumber = null)), ctx({ po: null }));
    assert.equal(r.outcome, "REVIEW");
    assert.ok(r.failed.includes(2));
  });

  it("price above PO → REVIEW on checks 3 and 4", () => {
    const r = run(
      invoice((i) => {
        i.lines[0] = { ...i.lines[0], unitPrice: "90.00", amount: "900.00" };
        i.subtotal = "1140.00";
        i.tax = "102.60";
        i.total = "1242.60";
      }),
    );
    assert.equal(r.outcome, "REVIEW");
    assert.deepEqual(r.failed, [3, 4]);
  });

  it("small unit price difference on many units → REVIEW (allowance is per line, not per unit)", () => {
    const r = run(
      invoice((i) => {
        i.lines[1] = { ...i.lines[1], unitPrice: "12.20", amount: "244.00" };
        i.subtotal = "1094.00";
        i.tax = "98.46";
        i.total = "1192.46";
      }),
    );
    const lines = r.checks.find((c) => c.id === 3)!;
    assert.equal(lines.status, "fail", JSON.stringify(lines));
  });

  it("price rounding of a cent on a few units → note only", () => {
    const r = run(
      invoice((i) => {
        i.lines[0] = { ...i.lines[0], unitPrice: "85.01", amount: "850.10" };
        i.subtotal = "1090.10";
        i.tax = "98.11";
        i.total = "1188.21";
      }),
    );
    assert.equal(r.outcome, "MATCHED_WITH_NOTE", JSON.stringify(r.checks, null, 2));
  });

  it("two invoice lines billing the same PO line are added up against what was received", () => {
    const r = run(
      invoice((i) => {
        i.lines = [
          { description: "Red rose stems box of 50", quantity: "10", unitPrice: "85.00", amount: "850.00" },
          { description: "Red rose stems box of 50", quantity: "10", unitPrice: "85.00", amount: "850.00" },
        ];
        i.subtotal = "1700.00";
        i.tax = "153.00";
        i.total = "1853.00";
      }),
    );
    assert.ok(r.failed.includes(3), JSON.stringify(r.checks, null, 2));
  });

  it("fees that are not on the PO → REVIEW on check 4", () => {
    const r = run(
      invoice((i) => {
        i.fees = "50.00";
        i.tax = "102.60";
        i.total = "1242.60";
      }),
    );
    assert.deepEqual(r.failed, [4]);
  });

  it("UEN on the invoice differs from the supplier record → REVIEW on check 6", () => {
    const r = run(invoice((i) => (i.supplier.uen = "199900001Z")));
    assert.deepEqual(r.failed, [6]);
  });

  it("more invoiced than received → REVIEW on check 3", () => {
    const r = run(invoice(), ctx({ po: { ...po, lines: [{ ...po.lines[0], receivedQty: "8" }, po.lines[1]] } }));
    assert.equal(r.outcome, "REVIEW");
    assert.deepEqual(r.failed, [3]);
  });

  it("already recorded → REVIEW on check 5", () => {
    const r = run(invoice(), ctx({ alreadyRecorded: true }));
    assert.deepEqual(r.failed, [5]);
  });

  it("bank account changed → REVIEW on check 6", () => {
    const r = run(invoice((i) => (i.bank.accountNumber = "072-999888-1")));
    assert.deepEqual(r.failed, [6]);
  });

  it("GST charged by a supplier not GST-registered → REVIEW on check 6", () => {
    const r = run(invoice(), ctx({ supplier: { ...supplier, gstRegNo: null } }));
    assert.deepEqual(r.failed, [6]);
  });

  it("reader unsure about a field → REVIEW on check 0", () => {
    const r = run(invoice((i) => (i.uncertainFields = ["total"])));
    assert.deepEqual(r.failed, [0]);
  });

  it("prices including GST are compared with PO prices before GST", () => {
    const r = run(
      invoice((i) => {
        i.pricesIncludeTax = true;
        i.lines = [
          { description: "Red rose stems box of 50", quantity: "10", unitPrice: "92.65", amount: "926.50" },
          { description: "Eucalyptus bunch", quantity: "20", unitPrice: "13.08", amount: "261.60" },
        ];
        i.subtotal = "1188.10";
        i.tax = "98.10";
        i.total = "1188.10";
      }),
    );
    assert.notEqual(r.outcome, "REVIEW", JSON.stringify(r.checks, null, 2));
  });
});
