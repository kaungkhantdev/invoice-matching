import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { JsonAccountingSource, type PurchaseOrder } from "../src/matching/accounting/accounting.source.js";
import { CheckerService } from "../src/matching/checker/checker.service.js";
import type { StandardInvoice } from "../src/matching/invoice.schema.js";
import { emptySeen, MatchingService, type PoReadResult, type ReadResult } from "../src/matching/matching.service.js";
import { sameCompany } from "../src/matching/normalize.js";
import type { PoRead } from "../src/matching/po.schema.js";
import { BedrockReader } from "../src/matching/reader/bedrock.reader.js";
import { uploadedPo } from "../src/matching/uploaded-po.js";

/**
 * PO GEN000073 as read from the two screenshots of our system's "Recurring PO Details" page, and the real Rentokil
 * invoice 0021490975 for the same site. The PO lists monthly charges with a frequency; its quantities count visits.
 */
const L = (code: string, description: string, frequency: string, quantity: string, unitPrice: string, total: string) => ({
  code,
  description,
  frequency,
  quantity,
  unitPrice,
  total,
});
const screenshots = (change: (po: PoRead) => void = () => {}): PoRead => {
  const po: PoRead = {
    documentType: "purchase_order",
    poNumber: "GEN000073",
    status: "APPROVED",
    orderDate: "2026-11-01",
    supplierName: "Rentokil Initial (S) Pte Ltd",
    site: "2 Changi South Street 2, Singapore 486759",
    currency: "SGD",
    contractRef: null,
    startDate: "2026-11-05",
    endDate: "2099-12-31",
    lines: [
      L("MWRC03", "115 X 180 Red/Citrine Welcome", "Monthly", "1", "7.00", "7.00"),
      L("MNGY02", "85 X 150 Black/White Classic", "Bi-weekly", "2", "5.00", "10.00"),
      L("MNGY01", "60 X 85 Black/White Classic", "Monthly", "5", "3.50", "17.50"),
      L("PTC056", "Dual Paper 170M 1Ply Livi", "Weekly", "3.333", "8.00", "26.66"),
      L("573225", "Signature Dual Sanitiser (W)", "Bi-monthly", "10.5", "6.00", "63.00"),
      L("TPC003", "JRT Jumbo Roll 600g", "Weekly", "18.666", "1.30", "24.27"),
      L("HSC012", "HWSC EcoWash Pearl Creme", "Bi-monthly", "2.5", "1.50", "3.75"),
      L("AFD004", "AFSD AirguardTec Disp", "Bi-monthly", "3", "4.50", "13.50"),
      L("SDB106", "Sani Bin Pedal BlueOSS", "Bi-weekly", "12", "1.80", "21.60"),
    ],
    grandTotal: "187.28",
    uncertainFields: [],
  };
  change(po);
  return po;
};
const poRead = (po: PoRead | null = screenshots(), error: string | null = null): PoReadResult => ({
  po,
  model: "m",
  error,
  retryable: false,
  seconds: 2,
});

const charged: [string, string, string][] = [
  ["Signature Dual Sanitiser - White (6 visits p.a.)", "21", "63.00"],
  ["AFSD AirguardTec Disp (6 visits p.a.)", "6", "13.50"],
  ["HWSC EcoWash Pearl Creme -5L (6 visits p.a.)", "5", "3.75"],
  ["60 X 85 Black/White Classic (12 visits p.a.)", "5", "17.50"],
  ["85 X 150 Black/White Classic (24 visits p.a.)", "1", "10.00"],
  ["115 X 180 Red/Citrine Welcome (12 visits p.a.)", "1", "7.00"],
  ["Dual Paper 170M 1Ply Livi (4 visits p.a.)", "10", "26.67"],
  ["Sani Bin Pedal Blue-OSS (24 visits p.a.)", "6", "21.60"],
  ["JRT Jumbo Roll 600g (4 visits p.a.)", "56", "24.27"],
];
const record = (date: string) => ({
  kind: "service report",
  site: "2 Changi South Street 2 Singapore 486759",
  dates: [date],
  signed: true,
  notDone: [] as string[],
});
/** The Rentokil invoice for `month`, e.g. "2026-10" (the real one) or "2026-11" (the first month the PO covers). */
function rentokil(month: string, change: (i: StandardInvoice) => void = () => {}): StandardInvoice {
  const inv: StandardInvoice = {
    documentType: "tax_invoice",
    supplier: { name: "Rentokil Initial Singapore Pte Ltd", uen: "195900145N", gstRegNo: "M2-0003184-9", address: null },
    bank: { accountHolder: null, accountNumber: "141-662528-001", swift: null },
    billTo: "Industrial & Commercial Facilities Management Pte Ltd",
    site: "SLC 1, 2 Changi South Street 2, Singapore 486759",
    servicePeriod: month,
    invoiceNumber: month === "2026-10" ? "0021490975" : `00215${month.slice(5)}000`,
    invoiceDate: `${month}-27`,
    dueDate: null,
    poNumber: null,
    currency: "SGD",
    pricesIncludeTax: false,
    lines: [
      ...charged.map(([description, quantity, amount]) => ({ description, quantity, unitPrice: null, amount })),
      { description: "Sign Jumbo Roll Tissue (W) (1 Visit p.a.)", quantity: "12", unitPrice: null, amount: "0" },
    ],
    subtotal: "187.29",
    tax: "16.86",
    fees: "0",
    discounts: "0",
    total: "204.15",
    uncertainFields: [],
    serviceRecords: [record(`${month}-08`), record(`${month}-23`)],
    otherInvoicesInFile: [],
  };
  change(inv);
  return inv;
}
const read = (invoice: StandardInvoice): ReadResult => ({
  invoice,
  readBy: "bedrock",
  model: "m",
  error: null,
  retryable: false,
  seconds: 1,
});

/** Rentokil on our supplier list; data/ also holds a keyed PO for the same site, which an uploaded PO must win over. */
async function matcher() {
  const dir = await mkdtemp(join(tmpdir(), "uploaded-po-"));
  const keyed: PurchaseOrder = {
    poNumber: "KEYED-1",
    supplierId: "SUP-RENTOKIL",
    currency: "SGD",
    site: "2 Changi South Street 2, Singapore 486759",
    period: "2026-10",
    lines: [{ description: "Something else entirely", orderedQty: "1", amount: "999.00" }],
  };
  const supplier = { id: "SUP-RENTOKIL", name: "Rentokil Initial Singapore Pte Ltd", uen: "195900145N", gstRegNo: "M2-0003184-9", bankAccountNumber: "141-662528-001" };
  await writeFile(join(dir, "suppliers.json"), JSON.stringify([supplier]));
  await writeFile(join(dir, "purchase-orders.json"), JSON.stringify([keyed]));
  await writeFile(join(dir, "recorded-invoices.json"), "[]");
  return new MatchingService(null as never, new CheckerService(), new JsonAccountingSource(dir));
}
const check = (r: Awaited<ReturnType<MatchingService["check"]>>, id: number) => r.checks.find((c) => c.id === id)!;

describe("PO read from screenshots", () => {
  it("becomes a recurring PO: supplier by name, contract dates, monthly charges with their frequency", () => {
    const { po, error, problems } = uploadedPo(poRead());
    assert.equal(error, null);
    assert.deepEqual(problems, []);
    assert.equal(po?.poNumber, "GEN000073");
    assert.equal(po?.supplierName, "Rentokil Initial (S) Pte Ltd");
    assert.equal(po?.supplierId, undefined);
    assert.deepEqual([po?.validFrom, po?.validTo, po?.status], ["2026-11-05", "2099-12-31", "APPROVED"]);
    assert.deepEqual(po?.lines[4], {
      description: "Signature Dual Sanitiser (W)",
      code: "573225",
      frequency: "Bi-monthly",
      unitPrice: "6.00",
      amount: "63.00",
      orderedQty: "10.5",
    });
  });

  it("says what doesn't add up: an item, a row read twice from overlapping screenshots, a missing number", () => {
    const wrongItem = uploadedPo(poRead(screenshots((po) => (po.lines[7].total = "14.50")))).problems;
    assert.ok(wrongItem.some((p) => /item 8 "AFSD AirguardTec Disp": 3 × 4\.50 = 13\.50, the PO shows 14\.50/.test(p)));
    const readTwice = uploadedPo(poRead(screenshots((po) => po.lines.push(po.lines[0])))).problems;
    assert.deepEqual(readTwice, ["the items add up to 194.28, its grand total is 187.28"]);
    const unclear = uploadedPo(poRead(screenshots((po) => {
      po.poNumber = null;
      po.startDate = "05/11/2026";
      po.uncertainFields = ["lines[3].total"];
    })));
    assert.deepEqual(unclear.problems, [
      "no PO number on it",
      'couldn\'t read the contract start date ("05/11/2026")',
      "not clear on the screenshots: lines[3].total",
    ]);
    assert.equal(unclear.po?.validFrom, undefined, "an unreadable date is not guessed");
  });

  it("a field cut off the screenshots is a problem, not a check quietly skipped", () => {
    const cropped = uploadedPo(poRead(screenshots((po) => {
      po.startDate = null;
      po.endDate = null;
      po.status = null;
      po.supplierName = null;
      po.site = null;
    })));
    assert.deepEqual(cropped.problems, [
      "the supplier isn't on the screenshots",
      "the status isn't on the screenshots",
      "the delivery site isn't on the screenshots",
      "the contract dates aren't on the screenshots",
    ]);
  });

  it("not a PO, or not read at all → no PO, and why", () => {
    assert.deepEqual(uploadedPo(poRead(screenshots((po) => (po.documentType = "other")))), {
      po: null,
      error: null,
      problems: ["the files don't show a purchase order"],
    });
    assert.deepEqual(uploadedPo(poRead(null, "Bedrock is busy")), { po: null, error: "Bedrock is busy", problems: [] });
  });

  it('"Rentokil Initial (S) Pte Ltd" is "Rentokil Initial Singapore Pte Ltd"', () => {
    assert.ok(sameCompany("Rentokil Initial (S) Pte Ltd", "Rentokil Initial Singapore Pte Ltd"));
    assert.ok(!sameCompany("Rentokil Initial (S) Pte Ltd", "Initial Hygiene Malaysia Sdn Bhd"));
  });
});

describe("Rentokil 0021490975 against PO GEN000073 (uploaded as screenshots)", () => {
  it("October: every line is on the PO, but the contract only starts in November → Review", async () => {
    const m = await matcher();
    const r = await m.check("Rentokil 0021490975.pdf", "h", read(rentokil("2026-10")), emptySeen(), false, poRead());
    assert.equal(r.outcome, "REVIEW");
    assert.equal(r.context?.poFoundBy, "uploaded");
    assert.equal(r.context?.po?.poNumber, "GEN000073", "the uploaded PO, not the one keyed in data/");
    assert.deepEqual(check(r, 2).details, [
      "The invoice doesn't quote PO GEN000073. Ask the supplier to quote it.",
      "Invoice is for 2026-10, PO GEN000073 starts 2026-11-05",
    ]);
    const charged = r.context!.lines.filter((line) => !line.free);
    assert.equal(charged.length, 9);
    assert.ok(charged.every((line) => line.po !== null && line.qtyStatus === "pass"), "PO counts visits: qty not compared");
    assert.deepEqual(
      charged.filter((line) => line.priceStatus !== "pass").map((line) => line.priceNote),
      ["Amount 26.67, the PO charges 26.66 a month (difference 0.01)"],
    );
    assert.deepEqual(check(r, 4).details, ["Subtotal at PO prices: invoice says 187.29, should be 187.28 (difference 0.01)"]);
  });

  it("November (inside the contract): matched with notes (PO number, a cent of rounding)", async () => {
    const m = await matcher();
    const r = await m.check("nov.pdf", "h", read(rentokil("2026-11")), emptySeen(), false, poRead());
    assert.equal(r.outcome, "MATCHED_WITH_NOTE");
    assert.equal(check(r, 2).status, "note");
    assert.equal(check(r, 3).status, "note");
  });

  it("the invoice quotes the PO: no note; it quotes another PO → Review", async () => {
    const m = await matcher();
    const quoted = await m.check("n.pdf", "h", read(rentokil("2026-11", (i) => (i.poNumber = "GEN 000073"))), emptySeen(), false, poRead());
    assert.deepEqual(check(quoted, 2).details, []);
    const other = await m.check("n.pdf", "h", read(rentokil("2026-11", (i) => (i.poNumber = "GEN000099"))), emptySeen(), false, poRead());
    assert.deepEqual(check(other, 2).details, ["Invoice quotes PO GEN000099, but the PO uploaded is GEN000073"]);
  });

  it("another supplier's PO, or a PO not approved → Review", async () => {
    const m = await matcher();
    const otherSupplier = poRead(screenshots((po) => (po.supplierName = "Initial Hygiene Malaysia Sdn Bhd")));
    const r1 = await m.check("n.pdf", "h", read(rentokil("2026-11")), emptySeen(), false, otherSupplier);
    assert.match(check(r1, 2).details.join(" "), /PO GEN000073 is for Initial Hygiene Malaysia Sdn Bhd, the invoice is from Rentokil/);
    for (const status of ["CANCELLED", "NOT APPROVED", "Unapproved", "Pending approval"]) {
      const r2 = await m.check("n.pdf", "h", read(rentokil("2026-11")), emptySeen(), false, poRead(screenshots((po) => (po.status = status))));
      assert.match(check(r2, 2).details.join(" "), new RegExp(`PO GEN000073 is ${status}, not approved`));
    }
    const approved = await m.check("n.pdf", "h", read(rentokil("2026-11")), emptySeen(), false, poRead(screenshots((po) => (po.status = " Approved "))));
    assert.doesNotMatch(check(approved, 2).details.join(" "), /not approved/);
  });

  it("October against screenshots without the contract box → still Review (the dates are missing, not assumed)", async () => {
    const m = await matcher();
    const cropped = poRead(screenshots((po) => ((po.startDate = null), (po.endDate = null))));
    const r = await m.check("oct.pdf", "h", read(rentokil("2026-10")), emptySeen(), false, cropped);
    assert.equal(r.outcome, "REVIEW");
    assert.match(check(r, 2).details.join(" "), /PO: the contract dates aren't on the screenshots/);
  });

  it("a monthly charge billed twice fails; the same charge split over two lines matches", async () => {
    const m = await matcher();
    const sani = (i: StandardInvoice) => i.lines.findIndex((line) => line.description.startsWith("Sani Bin"));
    const twice = rentokil("2026-11", (i) => {
      i.lines.push({ ...i.lines[sani(i)] });
      i.subtotal = "208.89";
      i.tax = "18.80";
      i.total = "227.69";
    });
    const r1 = await m.check("twice.pdf", "h", read(twice), emptySeen(), false, poRead());
    assert.equal(r1.outcome, "REVIEW");
    assert.match(check(r1, 3).details.join(" "), /Amount 21\.60, the PO allows 10\.80 of its 21\.60 a month/);
    const split = rentokil("2026-11", (i) => {
      const line = i.lines[sani(i)];
      i.lines.splice(sani(i), 1, { ...line, quantity: "3", amount: "10.80" }, { ...line, quantity: "3", amount: "10.80" });
    });
    const r2 = await m.check("split.pdf", "h", read(split), emptySeen(), false, poRead());
    assert.equal(check(r2, 3).status, "note", "only the Dual Paper cent");
    assert.deepEqual(check(r2, 4).details, ["Subtotal at PO prices: invoice says 187.29, should be 187.28 (difference 0.01)"]);
  });

  it("a PO that couldn't be read → Review, never a silent fall-back to the POs in data/", async () => {
    const m = await matcher();
    const r = await m.check("n.pdf", "h", read(rentokil("2026-10")), emptySeen(), false, poRead(null, "Bedrock is busy"));
    assert.equal(r.outcome, "REVIEW");
    assert.equal(r.context?.po, null);
    assert.deepEqual(check(r, 2).details, ["Couldn't read the PO: Bedrock is busy"]);
    assert.equal(check(r, 3).status, "skip");
  });

  it("a recurring PO is billed once a month: November and December pass, a second November invoice doesn't", async () => {
    const m = await matcher();
    const seen = emptySeen();
    for (const [file, month] of [["nov.pdf", "2026-11"], ["dec.pdf", "2026-12"]]) {
      const r = await m.check(file, file, read(rentokil(month)), seen, false, poRead());
      assert.equal(check(r, 5).status, "pass", file);
      m.remember(seen, file, file, r);
    }
    const again = rentokil("2026-11", (i) => (i.invoiceNumber = "0021599999"));
    const r = await m.check("nov-again.pdf", "h3", read(again), seen, false, poRead());
    assert.deepEqual(check(r, 5).details, ["PO GEN000073 (2026-11) is already billed by nov.pdf"]);
    assert.equal(check(r, 5).status, "fail");
  });
});

describe("BedrockReader.readPo", () => {
  const image = { kind: "image" as const, mediaType: "image/jpeg" as const, data: Buffer.from("fake-jpeg") };
  const answer = (text: string) => async () =>
    ({ stop_reason: "end_turn", content: [{ type: "text", text, citations: null }] }) as Pick<
      Anthropic.Beta.BetaMessage,
      "stop_reason" | "content"
    >;

  it("sends every screenshot in one call, with the PO instructions and structure", async () => {
    const bodies: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const ai = new BedrockReader(async (body) => {
      bodies.push(body);
      return answer(JSON.stringify(screenshots()))();
    });
    const po = await ai.readPo([
      { name: "top.webp", prepared: image },
      { name: "items.webp", prepared: image },
    ]);
    assert.equal(po.poNumber, "GEN000073");
    const content = bodies[0].messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    assert.deepEqual(content.map((block) => block.type), ["image", "image", "text"]);
    assert.match(String(bodies[0].system), /screenshots may overlap/);
    const format = bodies[0].output_config?.format as { type: string; schema: { properties: object } };
    assert.equal(format.type, "json_schema");
    assert.ok("grandTotal" in format.schema.properties, "the PO structure, not the invoice's");
  });

  it("an answer that doesn't fit → a plain error", async () => {
    await assert.rejects(new BedrockReader(answer('{"poNumber": 1}')).readPo([{ name: "a.png", prepared: image }]), /didn't fit our PO structure/);
  });
});
