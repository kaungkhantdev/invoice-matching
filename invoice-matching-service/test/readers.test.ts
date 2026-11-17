import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanAmount, normalizeInvoice } from "../src/invoice-matching/normalize.js";
import { XmlReader } from "../src/invoice-matching/reader/xml.reader.js";
import { buildUbl } from "../scripts/ubl.js";

describe("cleanAmount", () => {
  it("removes symbols and thousands separators", () => {
    assert.equal(cleanAmount("S$1,234.50"), "1234.50");
    assert.equal(cleanAmount("SGD 99"), "99");
    assert.equal(cleanAmount("(20.00)"), "-20.00");
    assert.equal(cleanAmount(""), "0");
    assert.equal(cleanAmount("abc"), null);
  });
});

describe("XmlReader (InvoiceNow)", () => {
  const xml = buildUbl({
    id: "INV-9",
    issueDate: "2026-11-03",
    dueDate: "2026-12-03",
    poNumber: "PO-9",
    supplier: { name: "Test Supplier Pte. Ltd.", uen: "201900001A", street: "1 Test Road", postalZone: "000001" },
    bank: { account: "0721234567", holder: "Test Supplier Pte. Ltd.", swift: "DBSSSGSG" },
    lines: [
      { name: "Item A", qty: "3", price: "30.00" },
      { name: "Item B", qty: "15", price: "10.00" },
    ],
  });

  it("reads every field with no AI", () => {
    const inv = new XmlReader().parse(xml);
    assert.equal(inv.invoiceNumber, "INV-9");
    assert.equal(inv.poNumber, "PO-9");
    assert.equal(inv.currency, "SGD");
    assert.equal(inv.supplier.uen, "201900001A");
    assert.equal(inv.supplier.gstRegNo, "201900001A");
    assert.equal(inv.bank.accountNumber, "0721234567");
    assert.equal(inv.lines.length, 2);
    assert.deepEqual(inv.lines[1], { description: "Item B", quantity: "15", unitPrice: "10.00", amount: "150.00" });
    assert.equal(inv.subtotal, "240.00");
    assert.equal(inv.tax, "21.60");
    assert.equal(inv.total, "261.60");
  });

  it("turns a price per 100 units (Peppol BaseQuantity) into a price per unit", () => {
    const per100 = xml.replace("<cbc:PriceAmount currencyID=\"SGD\">10.00</cbc:PriceAmount>", "<cbc:PriceAmount currencyID=\"SGD\">1000.00</cbc:PriceAmount><cbc:BaseQuantity>100</cbc:BaseQuantity>");
    assert.notEqual(per100, xml);
    assert.equal(new XmlReader().parse(per100).lines[1].unitPrice, "10");
  });

  it("flags a prepaid (deposit) amount for a person to look at", () => {
    const prepaid = xml.replace("<cbc:PayableAmount", "<cbc:PrepaidAmount currencyID=\"SGD\">100.00</cbc:PrepaidAmount><cbc:PayableAmount");
    assert.match(new XmlReader().parse(prepaid).uncertainFields.join(" "), /prepaid/);
  });

  it("rejects XML that isn't an invoice", () => {
    assert.throws(() => new XmlReader().parse("<Order><ID>1</ID></Order>"));
  });
});

describe("normalizeInvoice", () => {
  it("flags bad dates and amounts", () => {
    const inv = new XmlReader().parse(
      buildUbl({
        id: "X",
        issueDate: "2026-13-45",
        dueDate: "2026-12-03",
        poNumber: "PO",
        supplier: { name: "S", uen: "1", street: "s", postalZone: "1" },
        bank: { account: "1", holder: "S", swift: "X" },
        lines: [{ name: "A", qty: "1", price: "1.00" }],
      }),
    );
    inv.total = "twelve";
    const { problems } = normalizeInvoice(inv);
    assert.equal(problems.length, 2, problems.join("; "));
  });
});
