import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonAccountingSource, type PurchaseOrder, type SupplierRecord } from "../src/matching/accounting/accounting.source.js";
import { CheckerService } from "../src/matching/checker/checker.service.js";
import type { StandardInvoice } from "../src/matching/invoice.schema.js";
import { MatchingService, emptySeen, type ReadResult } from "../src/matching/matching.service.js";
import { sameCompany, sameSite } from "../src/matching/normalize.js";

/**
 * The real Rentokil invoice 0021490975 (October 2026, 2 Changi South Street 2), as the reader returns it,
 * and the PO our team would key for that site and month. Monthly service charges: amounts, no unit prices.
 */
const rentokil: SupplierRecord = {
  id: "SUP-RENTOKIL",
  name: "Rentokil Initial Singapore Pte Ltd",
  uen: "195900145N",
  gstRegNo: "M2-0003184-9",
  bankAccountNumber: ["141-662528-001", "0100124194"],
};

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
const free: [string, string][] = [
  ["Sign Jumbo Roll Tissue (W) (1 Visit p.a.)", "12"],
  ["Sign 1L Auto LSoap Disp (W) V2 (1 Visit p.a.)", "9"],
  ["TSpa 6KR (6 visits p.a.)", "6"],
  ["Compact Touchless 305M Paper Disp (1 Visit p.a.)", "7"],
  ["Sign Dual Sani 700ml - BioSan (6 visits p.a.)", "21"],
];

const SITE = "SLC 1, 2 Changi South Street 2, Singapore 486759";
const record = (date: string, extra: Partial<StandardInvoice["serviceRecords"][number]> = {}) => ({
  kind: "service report",
  site: "2 Changi South Street 2 Singapore 486759",
  dates: [date],
  signed: true,
  notDone: [] as string[],
  ...extra,
});

function octoberInvoice(change: (i: StandardInvoice) => void = () => {}): StandardInvoice {
  const inv: StandardInvoice = {
    documentType: "tax_invoice",
    supplier: { name: "Rentokil Initial Singapore Pte Ltd", uen: "195900145N", gstRegNo: "M2-0003184-9", address: "16 Jalan Mesin Singapore 368815" },
    bank: { accountHolder: "Rentokil Initial Singapore Pte Ltd", accountNumber: "141-662528-001", swift: "HSBCSGSG" },
    billTo: "Industrial & Commercial Facilities Management Pte Ltd",
    site: SITE,
    servicePeriod: "2026-10",
    invoiceNumber: "0021490975",
    invoiceDate: "2026-10-27",
    dueDate: "2026-11-26",
    poNumber: null,
    currency: "SGD",
    pricesIncludeTax: false,
    lines: [
      ...charged.map(([description, quantity, amount]) => ({ description, quantity, unitPrice: null, amount })),
      ...free.map(([description, quantity]) => ({ description, quantity, unitPrice: null, amount: "0" })),
    ],
    subtotal: "187.29",
    tax: "16.86",
    fees: "0",
    discounts: "0",
    total: "204.15",
    uncertainFields: [],
    serviceRecords: [
      record("2026-10-16", { notDone: ["HWSC EcoWash Pearl Creme -5L (No Stock, 0 of 5 done)"] }),
      record("2026-09-16"),
      record("2026-10-08"),
      record("2026-10-23"),
    ],
    otherInvoicesInFile: [],
  };
  change(inv);
  return inv;
}

/** The PO our team keys for this site and month: one line per charged item, with the monthly amount. */
const keyedPo = (poNumber: string, period: string, site = "2 Changi South Street 2, Singapore 486759"): PurchaseOrder => ({
  poNumber,
  supplierId: rentokil.id,
  currency: "SGD",
  site,
  period,
  lines: charged.map(([description, orderedQty, amount]) => ({ description: description.replace(/ \(.*\)$/, ""), orderedQty, amount })),
});

async function matcher(pos: PurchaseOrder[]) {
  const dir = await mkdtemp(join(tmpdir(), "keyed-po-"));
  await writeFile(join(dir, "suppliers.json"), JSON.stringify([rentokil]));
  await writeFile(join(dir, "purchase-orders.json"), JSON.stringify(pos));
  await writeFile(join(dir, "recorded-invoices.json"), "[]");
  return new MatchingService(null as never, new CheckerService(), new JsonAccountingSource(dir));
}
const read = (invoice: StandardInvoice): ReadResult => ({ invoice, readBy: "bedrock", model: "m", error: null, retryable: false, seconds: 1 });
const check = (r: Awaited<ReturnType<MatchingService["check"]>>, id: number) => r.checks.find((c) => c.id === id)!;

describe("Rentokil, 2 Changi South Street 2, October (no PO number on the invoice)", () => {
  it("is matched to the keyed PO by supplier, site and month, with a note to get the PO number", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10"), keyedPo("PO-2CSA1-2026-10", "2026-10", "2 Changi South Avenue 1, Singapore 486149")]);
    const r = await m.check("Rentokil 0021490975.pdf", "h1", read(octoberInvoice()), emptySeen());
    assert.equal(r.context?.po?.poNumber, "PO-2CSS2-2026-10");
    assert.equal(r.context?.poFoundBy, "site and month");
    assert.equal(check(r, 2).status, "note");
    assert.match(check(r, 2).details.join(" "), /No PO number on the invoice: matched to PO-2CSS2-2026-10.*Ask the supplier/);
    assert.equal(check(r, 1).status, "pass", "amounts only: no qty × price, totals add up");
    assert.equal(check(r, 4).status, "pass", "187.29 = the keyed amounts");
    assert.equal(check(r, 6).status, "pass", "HSBC account is one of the two on file");
    assert.equal(r.outcome, "MATCHED_WITH_NOTE");
  });

  it("free lines (loaned dispensers, included refills) don't need to be on the PO", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    const r = await m.check("f.pdf", "h", read(octoberInvoice()), emptySeen());
    assert.ok(r.context!.lines.filter((l) => l.free).length === 5);
    assert.doesNotMatch(check(r, 3).details.join(" "), /not on the PO/);
  });

  it("the service reports are the proof: a September report and the EcoWash 'No Stock' are noted", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    const c3 = check(await m.check("f.pdf", "h", read(octoberInvoice()), emptySeen()), 3);
    assert.equal(c3.status, "note");
    assert.match(c3.details.join(" "), /service report of 2026-09-16 is not in 2026-10/);
    assert.match(c3.details.join(" "), /"HWSC EcoWash Pearl Creme -5L \(6 visits p\.a\.\)" is billed, but the service report of 2026-10-16 says not done/);
  });

  it("no keyed PO for this site and month → Review", async () => {
    const m = await matcher([keyedPo("PO-2CSA1-2026-10", "2026-10", "2 Changi South Avenue 1, Singapore 486149"), keyedPo("PO-2CSS2-2026-09", "2026-09")]);
    const r = await m.check("f.pdf", "h", read(octoberInvoice()), emptySeen());
    assert.equal(r.outcome, "REVIEW");
    assert.match(check(r, 2).details.join(" "), /no PO for this supplier, site and month/);
  });
});

describe("Rentokil from November (PO number on the invoice)", () => {
  const november = octoberInvoice((i) => {
    i.invoiceNumber = "0021499999";
    i.invoiceDate = "2026-11-27";
    i.servicePeriod = "2026-11";
    i.poNumber = "PO-2CSS2-2026-11";
    i.serviceRecords = [record("2026-11-06"), record("2026-11-20")];
  });

  it("is matched by the PO number, and with signed reports in November everything passes", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-11", "2026-11")]);
    const r = await m.check("nov.pdf", "h2", read(november), emptySeen());
    assert.equal(r.context?.poFoundBy, "number");
    assert.equal(r.outcome, "MATCHED", JSON.stringify(r.checks.filter((c) => c.status !== "pass")));
  });

  it("the PO number of another site or month → Review", async () => {
    const m = await matcher([keyedPo("PO-X", "2026-10", "2 Changi South Avenue 1, Singapore 486149")]);
    const r = await m.check("nov.pdf", "h2", read({ ...november, poNumber: "PO-X" }), emptySeen());
    const c2 = check(r, 2).details.join(" ");
    assert.match(c2, /PO PO-X is for "2 Changi South Avenue 1/);
    assert.match(c2, /Invoice is for 2026-11, PO PO-X is for 2026-10/);
    assert.equal(r.outcome, "REVIEW");
  });

  it("more units than keyed, or a higher charge than keyed → Review", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-11", "2026-11")]);
    const more = structuredClone(november);
    more.lines[7] = { ...more.lines[7], quantity: "11", amount: "39.60" }; // Sani Bin: 11 billed at the right rate, 6 keyed
    more.subtotal = "205.29";
    more.tax = "18.48";
    more.total = "223.77";
    const c3 = check(await m.check("nov.pdf", "h3", read(more), emptySeen()), 3);
    assert.equal(c3.status, "fail");
    assert.match(c3.details.join(" "), /Invoiced 11, the PO has 6/);

    const pricier = structuredClone(november);
    pricier.lines[7] = { ...pricier.lines[7], amount: "25.00" }; // 6 bins, but 25.00 instead of 21.60
    pricier.subtotal = "190.69";
    pricier.tax = "17.16";
    pricier.total = "207.85";
    const p3 = check(await m.check("nov.pdf", "h4", read(pricier), emptySeen()), 3);
    assert.equal(p3.status, "fail");
    assert.match(p3.details.join(" "), /Sani Bin.*Amount 25\.00, PO allows 21\.60 for 6/);
  });

  it("no service record, or none signed in the month → Review", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-11", "2026-11")]);
    const none = check(await m.check("n.pdf", "h", read({ ...november, serviceRecords: [] }), emptySeen()), 3);
    assert.match(none.details.join(" "), /No signed service record/);
    const unsigned = check(await m.check("n.pdf", "h", read({ ...november, serviceRecords: [record("2026-11-06", { signed: false })] }), emptySeen()), 3);
    assert.equal(unsigned.status, "fail");
    assert.match(unsigned.details.join(" "), /No signed service record dated in 2026-11/);
  });

  it("billed to another company → Review", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-11", "2026-11")]);
    const r = await m.check("n.pdf", "h", read({ ...november, billTo: "Schenker Singapore Pte Ltd" }), emptySeen());
    assert.match(check(r, 2).details.join(" "), /Billed to "Schenker Singapore Pte Ltd", not to us/);
  });
});

describe("helping the reviewer when no PO fits", () => {
  it("a misread site (postal code off by a digit) names the supplier's PO for that month", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    // The site is misread, and no service record gives a readable address either.
    const misread = octoberInvoice((i) => {
      i.site = "SLC 1, 2 Changi South Street 2, Singapore 486756";
      i.serviceRecords = i.serviceRecords.map((r) => ({ ...r, site: null }));
    });
    const c2 = check(await m.check("f.pdf", "h", read(misread), emptySeen()), 2);
    assert.equal(c2.status, "fail");
    assert.match(c2.details.join(" "), /site read: "SLC 1, 2 Changi South Street 2, Singapore 486756".*POs for that month: PO-2CSS2-2026-10 \(2 Changi South Street 2, Singapore 486759\)\. Check the site\./);
  });

  it("tidies what the reader returns: addresses on one line; a quantity repeated in the description still pairs", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    const messy = octoberInvoice((i) => {
      i.site = "SLC 1\n2 Changi South Street 2\nSingapore 486759";
      i.lines[0] = { ...i.lines[0], description: "21 Signature Dual Sanitiser - White (6 visits p.a.)" };
    });
    const r = await m.check("f.pdf", "h", read(messy), emptySeen());
    assert.equal(r.invoice!.site, "SLC 1, 2 Changi South Street 2, Singapore 486759");
    // Kept as read (a number can be part of a name), but still paired with its PO line.
    assert.equal(r.invoice!.lines[0].description, "21 Signature Dual Sanitiser - White (6 visits p.a.)");
    assert.equal(r.context!.lines[0].po?.description, "Signature Dual Sanitiser - White");
    assert.equal(r.outcome, "MATCHED_WITH_NOTE");
  });

  it("a blank quantity is a read problem, not a silent 0", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    const r = await m.check("f.pdf", "h", read(octoberInvoice((i) => (i.lines[0] = { ...i.lines[0], quantity: "" }))), emptySeen());
    assert.match(check(r, 0).details.join(" "), /Line 1 quantity is missing/);
  });
});

describe("Masandao: several invoices in one PDF", () => {
  it("only the first is read, so the file goes to Review with the numbers to split out", () => {
    const inv = octoberInvoice((i) => {
      i.invoiceNumber = "90709";
      i.otherInvoicesInFile = ["90710", "90711"];
    });
    const c0 = new CheckerService().run(inv, { supplier: rentokil, po: null, alreadyRecorded: false, duplicateInBatch: null, readProblems: [] })[0];
    assert.equal(c0.status, "fail");
    assert.match(c0.details.join(" "), /2 more invoice\(s\) \(90710, 90711\).*Split the file/);
  });
});

describe("site and company names", () => {
  it("same site: by postal code, or by street with the same house numbers", () => {
    assert.ok(sameSite("2 Changi South Street 2, Singapore 486759", "SLC 1, 2 Changi South Street 2 Singapore 486759"));
    assert.ok(sameSite("2 Changi South Street 2", "SLC 1, 2 Changi South Street 2"));
    assert.ok(sameSite("No 1 Changi North Way", "ICFM-DSV Solutions PL, No 1 Changi North Way"));
    assert.ok(!sameSite("2 Changi South Street 2, Singapore 486759", "2 Changi South Avenue 1, Singapore 486149"));
    assert.ok(!sameSite("2 Changi South Street 2", "2 Changi South Avenue 1"));
    assert.ok(!sameSite("No 1 Changi North Way", "No 5 Changi North Way"));
  });

  it("same company, with the usual short forms; not a look-alike", () => {
    const us = "Industrial & Commercial Facilities Management Pte Ltd";
    assert.ok(sameCompany(us, "Industrial & Commercial Facilities Mgm Pte Ltd"));
    assert.ok(sameCompany(us, "Industrial & Commercial Facilities Mgt PL"));
    assert.ok(sameCompany(us, "Industrial & Commercial Facilities Management"));
    assert.ok(!sameCompany(us, "Industrial Commercial Facilities Services Pte Ltd"));
    assert.ok(!sameCompany(us, "Schenker Singapore Pte Ltd"));
  });
});

describe("review fixes", () => {
  const november = () =>
    octoberInvoice((i) => {
      i.invoiceNumber = "0021499999";
      i.invoiceDate = "2026-11-27";
      i.servicePeriod = "2026-11";
      i.poNumber = "PO-2CSS2-2026-11";
      i.serviceRecords = [record("2026-11-06")];
    });

  it("a monthly amount is shared pro rata: 4 of 6 bins at the full 21.60 is too much; the charge split over two lines is fine", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-11", "2026-11")]);
    const four = structuredClone(november());
    four.lines[7] = { ...four.lines[7], quantity: "4" }; // still 21.60
    const c3 = check(await m.check("n.pdf", "h", read(four), emptySeen()), 3);
    assert.match(c3.details.join(" "), /Sani Bin.*Amount 21\.60, PO allows 14\.40 for 4/);

    const split = structuredClone(november());
    split.lines.splice(7, 1, { ...split.lines[7], quantity: "3", amount: "10.80" }, { ...split.lines[7], quantity: "3", amount: "10.80" });
    assert.equal((await m.check("n.pdf", "h", read(split), emptySeen())).outcome, "MATCHED");

    const twice = structuredClone(november());
    twice.lines.splice(7, 1, { ...twice.lines[7], quantity: "3" }, { ...twice.lines[7], quantity: "3" }); // 21.60 + 21.60
    twice.subtotal = "208.89";
    twice.tax = "18.80";
    twice.total = "227.69";
    assert.equal((await m.check("n.pdf", "h", read(twice), emptySeen())).outcome, "REVIEW");
  });

  it("the same monthly PO billed again by another invoice → Review (in the batch, or already recorded)", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-11", "2026-11")]);
    const seen = emptySeen();
    const first = await m.check("first.pdf", "h1", read(november()), seen);
    m.remember(seen, "first.pdf", "h1", first);
    const again = november();
    again.invoiceNumber = "0021500000";
    const r = await m.check("second.pdf", "h2", read(again), seen);
    assert.equal(check(r, 5).status, "fail");
    assert.match(check(r, 5).details.join(" "), /PO PO-2CSS2-2026-11 \(2026-11\) is already billed by first\.pdf/);
  });

  it("only the right building: '8 Changi South Street 2' is not '2 Changi South Street 2'; abbreviations are fine", () => {
    assert.ok(!sameSite("2 Changi South Street 2, Singapore 486759", "8 Changi South Street 2"));
    assert.ok(!sameSite("2 Changi South Street 2", "2 Changi South Street 3"));
    assert.ok(!sameSite("Blk 21 Tampines St 21", "Blk 211 Tampines St 21"));
    assert.ok(sameSite("2 Changi South Street 2, Singapore 486759", "2 Changi South St 2"));
    assert.ok(sameSite("10 Ubi Crescent", "10 Ubi Cres"));
  });

  it("a site printed only by name ('ICFM-Siglap Centre') is matched through the address on the signed service card", async () => {
    const masandao: SupplierRecord = { id: "SUP-MASANDAO", name: "Masandao Pte Ltd", uen: "201612471N", gstRegNo: "201612471N", bankAccountNumber: "344-307-486-2" };
    const dir = await mkdtemp(join(tmpdir(), "keyed-po-"));
    await writeFile(join(dir, "suppliers.json"), JSON.stringify([masandao]));
    const po: PurchaseOrder = {
      poNumber: "PO-SIGLAP-2026-08", supplierId: masandao.id, currency: "SGD", site: "55 Siglap Centre, Singapore 455871", period: "2026-08",
      lines: [{ description: "Air Spray Fragrance - 6000", orderedQty: "8", unitPrice: "2.80" }, { description: "Lady Sanitary Bin Pedal", orderedQty: "14", unitPrice: "3.80" }],
    };
    await writeFile(join(dir, "purchase-orders.json"), JSON.stringify([po]));
    await writeFile(join(dir, "recorded-invoices.json"), "[]");
    const m = new MatchingService(null as never, new CheckerService(), new JsonAccountingSource(dir));
    const inv: StandardInvoice = {
      ...octoberInvoice(),
      supplier: { name: "Masandao Pte Ltd", uen: "201612471N", gstRegNo: "201612471N", address: null },
      bank: { accountHolder: null, accountNumber: "344-307-486-2", swift: null },
      billTo: "Industrial & Commercial Facilities Mgm Pte Ltd",
      site: "ICFM-Siglap Centre",
      servicePeriod: "2026-08",
      invoiceNumber: "90712",
      invoiceDate: "2026-08-31",
      lines: [
        { description: "Digital Air Spray Dispenser - Aerosol", quantity: "8", unitPrice: "0.00", amount: "0.00" },
        { description: "Air Spray Fragrance - 6000", quantity: "8", unitPrice: "2.80", amount: "22.40" },
        { description: "Lady Sanitary Bin Pedal", quantity: "14", unitPrice: "3.80", amount: "53.20" },
      ],
      subtotal: "75.60",
      tax: "6.80",
      total: "82.40",
      serviceRecords: [{ kind: "service card", site: "Siglap Centre, 55 Siglap Centre, Singapore 455871", dates: ["2026-08-08", "2026-08-22"], signed: true, notDone: [] }],
    };
    const r = await m.check("90712.pdf", "h", read(inv), emptySeen());
    assert.equal(r.context?.po?.poNumber, "PO-SIGLAP-2026-08");
    assert.equal(r.outcome, "MATCHED_WITH_NOTE", JSON.stringify(r.checks.filter((c) => c.status !== "pass")));
  });

  it("billed in arrears with no month printed: the month comes from the signed service records", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    const arrears = octoberInvoice((i) => {
      i.servicePeriod = null;
      i.invoiceDate = "2026-11-03";
      i.serviceRecords = [record("2026-10-08"), record("2026-10-23")];
    });
    const r = await m.check("f.pdf", "h", read(arrears), emptySeen());
    assert.equal(r.context?.po?.poNumber, "PO-2CSS2-2026-10");
    assert.deepEqual(r.context?.month, { value: "2026-10", from: "service records" });
  });

  it("a goods-only invoice against a PO that also has a service line needs no service record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keyed-po-"));
    await writeFile(join(dir, "suppliers.json"), JSON.stringify([rentokil]));
    await writeFile(join(dir, "purchase-orders.json"), JSON.stringify([{
      poNumber: "PO-MIX", supplierId: rentokil.id, currency: "SGD",
      lines: [
        { description: "Sani Bin Pedal Blue-OSS", orderedQty: "6", amount: "21.60" },
        { description: "Wall dispenser installation kit", unitPrice: "40.00", orderedQty: "2", receivedQty: "2" },
      ],
    }]));
    await writeFile(join(dir, "recorded-invoices.json"), "[]");
    const m = new MatchingService(null as never, new CheckerService(), new JsonAccountingSource(dir));
    const goods = octoberInvoice((i) => {
      i.poNumber = "PO-MIX";
      i.lines = [{ description: "Wall dispenser installation kit", quantity: "2", unitPrice: "40.00", amount: "80.00" }];
      i.subtotal = "80.00";
      i.tax = "7.20";
      i.total = "87.20";
      i.serviceRecords = [];
    });
    const c3 = check(await m.check("g.pdf", "h", read(goods), emptySeen()), 3);
    assert.equal(c3.status, "pass", JSON.stringify(c3));
  });

  it("a 'not done' item with a long reason still finds its billed line", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    const inv = octoberInvoice((i) => {
      i.serviceRecords = [record("2026-10-16", { notDone: ["HWSC EcoWash Pearl Creme -5L: No stock at the depot this week, outstanding unresolved issue, will deliver next visit"] })];
    });
    assert.match(check(await m.check("f.pdf", "h", read(inv), emptySeen()), 3).details.join(" "), /EcoWash.*is billed, but the service report of 2026-10-16 says not done/);
  });
});

describe("final review fixes", () => {
  const nov = () =>
    octoberInvoice((i) => {
      i.invoiceNumber = "0021499999";
      i.invoiceDate = "2026-11-27";
      i.servicePeriod = "2026-11";
      i.poNumber = "PO-2CSS2-2026-11";
      i.serviceRecords = [record("2026-11-06")];
    });

  it("only a real invoice from the PO's supplier uses up a PO (not a delivery order, nor another supplier's typo)", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-11", "2026-11")]);
    const seen = emptySeen();
    const deliveryOrder = { ...nov(), documentType: "delivery_order" as const, invoiceNumber: "DO-1" };
    m.remember(seen, "do.pdf", "h0", await m.check("do.pdf", "h0", read(deliveryOrder), seen));
    const r = await m.check("invoice.pdf", "h1", read(nov()), seen);
    assert.equal(check(r, 5).status, "pass", JSON.stringify(check(r, 5)));
  });

  it("billed once applies to service POs; a goods PO may be billed in parts (a note)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keyed-po-"));
    await writeFile(join(dir, "suppliers.json"), JSON.stringify([rentokil]));
    await writeFile(join(dir, "purchase-orders.json"), JSON.stringify([{
      poNumber: "PO-GOODS", supplierId: rentokil.id, currency: "SGD", site: SITE, period: "2026-11",
      lines: [{ description: "Wall dispenser installation kit", unitPrice: "40.00", orderedQty: "4", receivedQty: "4" }],
    }]));
    await writeFile(join(dir, "recorded-invoices.json"), JSON.stringify([{ supplierId: rentokil.id, invoiceNumber: "G-1", poNumber: "PO-GOODS" }]));
    const m = new MatchingService(null as never, new CheckerService(), new JsonAccountingSource(dir));
    const goods = octoberInvoice((i) => {
      i.invoiceNumber = "G-2";
      i.poNumber = "PO-GOODS";
      i.servicePeriod = "2026-11";
      i.lines = [{ description: "Wall dispenser installation kit", quantity: "2", unitPrice: "40.00", amount: "80.00" }];
      i.subtotal = "80.00";
      i.tax = "7.20";
      i.total = "87.20";
      i.serviceRecords = [];
    });
    const c5 = check(await m.check("g2.pdf", "h", read(goods), emptySeen()), 5);
    assert.equal(c5.status, "note");
    assert.match(c5.details.join(" "), /already billed by recorded invoice G-1/);
  });

  it("while an invoice is read again it still holds its PO, so a later invoice for it stays flagged", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-11", "2026-11")]);
    const first = await m.check("first.pdf", "h1", read(nov()), emptySeen());
    const held = m.claims(first);
    assert.equal(held.poKey, "PO2CSS2202611");
    const seen = emptySeen();
    m.remember(seen, "first.pdf", "h1", held);
    const again = { ...nov(), invoiceNumber: "0021500000" };
    assert.equal(check(await m.check("second.pdf", "h2", read(again), seen), 5).status, "fail");
  });

  it("the service-proof month follows the PO when only the invoice date gives a month", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    const arrears = octoberInvoice((i) => {
      i.poNumber = "PO-2CSS2-2026-10";
      i.servicePeriod = null;
      i.invoiceDate = "2026-11-03";
      i.serviceRecords = [record("2026-10-08", { signed: false })]; // unsigned: no month from the records
    });
    const c3 = check(await m.check("a.pdf", "h", read(arrears), emptySeen()), 3);
    assert.match(c3.details.join(" "), /No signed service record dated in 2026-10/);
  });

  it("a 'not done' item is reported against the best-matching line", async () => {
    const m = await matcher([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    const inv = octoberInvoice((i) => (i.serviceRecords = [record("2026-10-16", { notDone: ["85 X 150 Black/White Classic: not done"] })]));
    const details = check(await m.check("f.pdf", "h", read(inv), emptySeen()), 3).details.join(" ");
    assert.match(details, /"85 X 150 Black\/White Classic \(24 visits p\.a\.\)" is billed/);
    assert.doesNotMatch(details, /"60 X 85/);
  });

  it("postal codes written 'S486759'; 'Pl' means Place", () => {
    assert.ok(sameSite("2 Changi South Street 2, S486759", "2 Changi South Street 2, Singapore 486759"));
    assert.ok(!sameSite("2 Changi South Street 2, S486759", "2 Changi South Avenue 1, Singapore 486149"));
    assert.ok(sameSite("12 Kallang Pl", "12 Kallang Place"));
    assert.ok(!sameSite("12 Kallang Pl", "12 Kallang Avenue"));
    assert.ok(sameSite("No 1 Changi North Way", "ICFM-DSV Solutions PL, No 1 Changi North Way"));
  });
});

describe("data/ files and approvals", () => {
  async function dataDir(pos: PurchaseOrder[], recorded: unknown[] = []) {
    const dir = await mkdtemp(join(tmpdir(), "keyed-po-"));
    await writeFile(join(dir, "suppliers.json"), JSON.stringify([rentokil]));
    await writeFile(join(dir, "purchase-orders.json"), JSON.stringify(pos));
    await writeFile(join(dir, "recorded-invoices.json"), JSON.stringify(recorded));
    return dir;
  }

  it("an approved invoice the team then recorded is not a duplicate of itself; an unapproved copy still is", async () => {
    const inv = octoberInvoice();
    const recorded = [{ supplierId: rentokil.id, invoiceNumber: inv.invoiceNumber, poNumber: "PO-2CSS2-2026-10" }];
    const m = new MatchingService(null as never, new CheckerService(), new JsonAccountingSource(await dataDir([keyedPo("PO-2CSS2-2026-10", "2026-10")], recorded)));
    assert.equal(check(await m.check("a.pdf", "h", read(inv), emptySeen(), true), 5).status, "pass");
    assert.equal(check(await m.check("a.pdf", "h", read(inv), emptySeen()), 5).status, "fail");
  });

  it("a broken data/ file is named, and leaves the data as it was (not half updated)", async () => {
    const dir = await dataDir([keyedPo("PO-2CSS2-2026-10", "2026-10")]);
    const source = new JsonAccountingSource(dir);
    await writeFile(join(dir, "suppliers.json"), JSON.stringify([{ ...rentokil, bankAccountNumber: "999-999999-9" }]));
    await writeFile(join(dir, "recorded-invoices.json"), "[{],");
    await assert.rejects(source.reload(), /recorded-invoices\.json/);
    assert.deepEqual((await source.findSupplier(octoberInvoice()))?.bankAccountNumber, rentokil.bankAccountNumber);
  });

  it("a PO field keyed as \"\" means not given; a broken PO number sends the invoice to Review instead of stopping", async () => {
    const blank = keyedPo("PO-2CSS2-2026-10", "2026-10");
    blank.lines = blank.lines.map((l) => ({ ...l, amount: "", receivedQty: "" }));
    const m = new MatchingService(null as never, new CheckerService(), new JsonAccountingSource(await dataDir([blank])));
    const r = await m.check("b.pdf", "h", read(octoberInvoice()), emptySeen());
    assert.equal(r.error, null);
    assert.ok(r.context!.lines.some((l) => l.priceNote === "The PO line has no price"), JSON.stringify(check(r, 3)));

    const broken = keyedPo("PO-2CSS2-2026-10", "2026-10");
    broken.lines = broken.lines.map((l) => ({ ...l, orderedQty: "six" }));
    const m2 = new MatchingService(null as never, new CheckerService(), new JsonAccountingSource(await dataDir([broken])));
    const r2 = await m2.check("c.pdf", "h", read(octoberInvoice()), emptySeen());
    assert.equal(r2.outcome, "REVIEW");
    assert.match(r2.error ?? "", /^The checks failed: /);
  });
});
