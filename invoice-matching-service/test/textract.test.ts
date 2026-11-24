import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalyzeExpenseCommandOutput, ExpenseField } from "@aws-sdk/client-textract";
import type { PurchaseOrder, SupplierRecord } from "../src/invoice-matching/accounting/accounting.source.js";
import { CheckerService } from "../src/invoice-matching/checker/checker.service.js";
import type { StandardInvoice } from "../src/invoice-matching/invoice.schema.js";
import { RetryableError } from "../src/invoice-matching/reader/extractor.js";
import { TextractReader, pickFields, type TextractRead } from "../src/invoice-matching/reader/textract.reader.js";

const field = (type: string, value: string, confidence = 99, typeConfidence = 99): ExpenseField => ({
  Type: { Text: type, Confidence: typeConfidence },
  ValueDetection: { Text: value, Confidence: confidence },
});

/** A fake Textract: one AnalyzeExpense answer per page (fields + the page's text lines). */
const fakeTextract = (pages: { fields?: ExpenseField[]; lines?: string[] }[]) => {
  let call = 0;
  return async () => {
    const page = pages[call++] ?? {};
    const blocks = (page.lines ?? []).map((text, i) => ({ BlockType: "LINE", Id: `p${call}-l${i}`, Text: text }));
    return { ExpenseDocuments: [{ SummaryFields: page.fields ?? [], Blocks: blocks }] } as unknown as AnalyzeExpenseCommandOutput;
  };
};

const onePageAnswer = () =>
  ({ ExpenseDocuments: [{ SummaryFields: [], Blocks: [{ BlockType: "LINE", Id: "l", Text: "TOTAL 10.00" }] }] }) as unknown as AnalyzeExpenseCommandOutput;

const failWith = (name: string, extra: Record<string, unknown> = {}) => async () => {
  throw Object.assign(new Error(`${name} happened`), { name, ...extra });
};

describe("Textract fields", () => {
  it("picks the fields we compare, cleaned", () => {
    const f = pickFields([
      field("INVOICE_RECEIPT_ID", "TBR-0457"),
      field("PO_NUMBER", "PO-2026-0103"),
      field("TOTAL", "S$ 260.00"),
      field("TAX", "0.00"),
      field("VENDOR_GST_NUMBER", "201912345K"),
      field("VENDOR_NAME", "Tiong Bahru Ribbon & Craft"),
    ]);
    assert.deepEqual(f, {
      invoiceNumber: "TBR-0457",
      poNumber: "PO-2026-0103",
      subtotal: null,
      tax: "0.00",
      total: "260.00",
      totalFrom: "TOTAL",
      gstRegNo: "201912345K",
      supplierName: "Tiong Bahru Ribbon & Craft",
    });
  });

  it("ignores unsure values, and values the pages disagree on", () => {
    const f = pickFields([field("INVOICE_RECEIPT_ID", "TBR-0457", 40), field("TOTAL", "260.00"), field("TOTAL", "250.00")]);
    assert.equal(f.invoiceNumber, null);
    assert.equal(f.total, null);
  });

  it("ignores a field Textract isn't sure is that kind of field", () => {
    assert.equal(pickFields([field("TOTAL", "40", 99, 45), field("AMOUNT_DUE", "1,035.50")]).total, "1035.50");
  });

  it("doesn't turn IDs or rates into amounts", () => {
    assert.equal(pickFields([field("TAX", "GST Reg No. 201912345K")]).tax, null);
    assert.equal(pickFields([field("TAX", "S$ 85.50")]).tax, "85.50");
  });

  it("uses 'amount due' only when there is no total at all", () => {
    assert.equal(pickFields([field("AMOUNT_DUE", "100.00")]).total, "100.00");
    assert.equal(pickFields([field("AMOUNT_DUE", "100.00")]).totalFrom, "AMOUNT_DUE");
    assert.equal(pickFields([field("TOTAL", "120.00"), field("AMOUNT_DUE", "100.00")]).total, "120.00");
  });
});

describe("Textract reader", () => {
  it("reads every page: fields merged, text page by page for the AI", async () => {
    const reader = new TextractReader(
      fakeTextract([
        { fields: [field("INVOICE_RECEIPT_ID", "INV-1")], lines: ["TAX INVOICE", "INV-1"] },
        { fields: [field("TOTAL", "92.65")], lines: ["TOTAL 92.65"] },
      ]),
      1000,
    );
    const { read, text } = await reader.read([Buffer.from("page1"), Buffer.from("page2")]);
    assert.equal(read.error, null);
    assert.equal(read.pages, 2);
    assert.equal(read.fields.invoiceNumber, "INV-1");
    assert.equal(read.fields.total, "92.65");
    assert.equal(text, "--- Page 1 of 2 ---\nTAX INVOICE\nINV-1\n\n--- Page 2 of 2 ---\nTOTAL 92.65");
  });

  it("says which pages it didn't read", async () => {
    const { read, text } = await new TextractReader(fakeTextract([{ lines: ["page one"] }]), 1000).read([Buffer.from("1")], 3);
    assert.equal(read.skippedPages, 3);
    assert.match(text ?? "", /Page 1 of 4[\s\S]*last 3 page\(s\) were not read/);
  });

  it("keeps to the AWS rate limit: 3 pages at 10 requests/second take at least 0.2 s", async () => {
    const reader = new TextractReader(fakeTextract([{}, {}, {}]), 10);
    const started = Date.now();
    await reader.read([Buffer.from("1"), Buffer.from("2"), Buffer.from("3")]);
    assert.ok(Date.now() - started >= 190, `took ${Date.now() - started} ms`);
  });

  it("busy (throttled, 5xx, network) → RetryableError: the queue tries again later", async () => {
    await assert.rejects(new TextractReader(failWith("ThrottlingException"), 1000).read([Buffer.from("x")]), RetryableError);
    await assert.rejects(new TextractReader(failWith("Oops", { $metadata: { httpStatusCode: 503 } }), 1000).read([Buffer.from("x")]), RetryableError);
    await assert.rejects(new TextractReader(failWith("Error", { code: "ECONNRESET" }), 1000).read([Buffer.from("x")]), RetryableError);
    // VPN or route down: no HTTP answer at all.
    await assert.rejects(new TextractReader(failWith("Error", { code: "ENETUNREACH" }), 1000).read([Buffer.from("x")]), RetryableError);
    await assert.rejects(new TextractReader(failWith("Error", { code: "EHOSTUNREACH" }), 1000).read([Buffer.from("x")]), RetryableError);
  });

  it("a local error with an E… code but no network meaning (e.g. a missing login token file) stays a plain error", async () => {
    const reader = new TextractReader(failWith("Error", { code: "ENOENT", message: "ENOENT: no such file or directory, open '/var/run/token'" }), 1000);
    await assert.rejects(reader.read([Buffer.from("x")]), (e: Error) => !(e instanceof RetryableError));
  });

  it("an SSO login refresh that fails because the network is down → RetryableError, not 'no login'", async () => {
    const reader = new TextractReader(failWith("CredentialsProviderError", { message: "getaddrinfo ENOTFOUND portal.sso.ap-southeast-1.amazonaws.com" }), 1000);
    await assert.rejects(reader.read([Buffer.from("x")]), RetryableError);
  });

  it("other ways an SSO login can fail to refresh (fetch failed, a short token ran out offline) → RetryableError", async () => {
    for (const [name, message] of [
      ["CredentialsProviderError", "TypeError: fetch failed"],
      ["TokenProviderError", "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile."],
    ]) {
      await assert.rejects(new TextractReader(failWith(name, { message }), 1000).read([Buffer.from("x")]), RetryableError, message);
    }
  });

  it("no AWS login found → tried again (a login helper may only be offline), and says how to log in", async () => {
    const reader = new TextractReader(failWith("CredentialsProviderError", { message: "Could not load credentials from any providers" }), 1000);
    await assert.rejects(reader.read([Buffer.from("x")]), (e: Error) => e instanceof RetryableError && /no AWS login found.*aws configure/.test(e.message));
  });

  it("AWS rejected the login (expired keys) → a plain error saying to log in again", async () => {
    const reader = new TextractReader(failWith("ExpiredTokenException", { $metadata: { httpStatusCode: 400 } }), 1000);
    await assert.rejects(reader.read([Buffer.from("x")]), (e: Error) => !(e instanceof RetryableError) && /aws sso login/.test(e.message));
  });

  it("'network is down' and similar socket errors → RetryableError", async () => {
    for (const code of ["ENETDOWN", "EADDRNOTAVAIL"]) {
      await assert.rejects(new TextractReader(failWith("Error", { code }), 1000).read([Buffer.from("x")]), RetryableError, code);
    }
  });

  it("a page Textract can't read → no throw: the AI reads alone, check 0 gets a note", async () => {
    const { read, text } = await new TextractReader(failWith("UnsupportedDocumentException"), 1000).read([Buffer.from("x")]);
    assert.match(read.error ?? "", /couldn't read it/);
    assert.equal(text, null);
  });

  it("one bad page doesn't throw away the others", async () => {
    let call = 0;
    const reader = new TextractReader(async () => {
      call++;
      if (call === 2) throw Object.assign(new Error("too big"), { name: "DocumentTooLargeException" });
      const n = call;
      return { ExpenseDocuments: [{ SummaryFields: n === 3 ? [field("TOTAL", "92.65")] : [], Blocks: [{ BlockType: "LINE", Id: `l${n}`, Text: `line on page ${n}` }] }] } as unknown as AnalyzeExpenseCommandOutput;
    }, 1000);
    const { read, text } = await reader.read([Buffer.from("1"), Buffer.from("2"), Buffer.from("3")]);
    assert.equal(call, 3, "page 3 is still read");
    assert.match(read.error ?? "", /page 2: too large/);
    assert.equal(read.fields.total, "92.65");
    assert.match(text ?? "", /line on page 1[\s\S]*Page 2 of 3: Textract couldn't read this page[\s\S]*line on page 3/);
  });

  it("pages already read for a file are reused: the same file again costs nothing", async () => {
    let sends = 0;
    const reader = new TextractReader(async () => {
      sends++;
      return onePageAnswer();
    }, 1000);
    await reader.read([Buffer.from("1"), Buffer.from("2")], 0, "file-A");
    await reader.read([Buffer.from("1"), Buffer.from("2")], 0, "file-A");
    assert.equal(sends, 2);
  });

  it("busy on page 2 of 3: the retry pays only for pages 2 and 3", async () => {
    let sends = 0;
    let busy = true;
    const reader = new TextractReader(async () => {
      sends++;
      if (sends === 2 && busy) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      return onePageAnswer();
    }, 1000);
    const pages = [Buffer.from("1"), Buffer.from("2"), Buffer.from("3")];
    await assert.rejects(reader.read(pages, 0, "file-B"), RetryableError);
    busy = false;
    await reader.read(pages, 0, "file-B");
    assert.equal(sends, 4, "page 1 once, page 2 twice (busy, then ok), page 3 once");
  });

  it("the same file read twice at the same moment (two copies in one upload): one request per page", async () => {
    let sends = 0;
    const reader = new TextractReader(async () => {
      sends++;
      await new Promise((r) => setTimeout(r, 20));
      return onePageAnswer();
    }, 1000);
    await Promise.all([reader.read([Buffer.from("1")], 0, "file-C"), reader.read([Buffer.from("1")], 0, "file-C")]);
    assert.equal(sends, 1);
  });
});

// ── check 0 with Textract ─────────────────────────────────────────────

const supplier: SupplierRecord = { id: "S", name: "Tiong Bahru Ribbon & Craft", uen: "53312345A", gstRegNo: null, bankAccountNumber: "3513012345" };
const po: PurchaseOrder = {
  poNumber: "PO-2026-0103",
  supplierId: "S",
  currency: "SGD",
  lines: [{ description: "Satin ribbon 25mm roll", unitPrice: "6.50", orderedQty: "40", receivedQty: "40" }],
};
const invoice: StandardInvoice = {
  documentType: "invoice",
  supplier: { name: "Tiong Bahru Ribbon & Craft", uen: "53312345A", gstRegNo: null, address: null },
  bank: { accountHolder: null, accountNumber: "351-301-234-5", swift: null },
  invoiceNumber: "TBR-0457",
  invoiceDate: "2026-11-06",
  dueDate: null,
  poNumber: "PO-2026-0103",
  currency: "SGD",
  pricesIncludeTax: false,
  lines: [{ description: "Satin ribbon 25mm roll", quantity: "40", unitPrice: "6.50", amount: "260.00" }],
  subtotal: "260.00",
  tax: "0",
  fees: "0",
  discounts: "0",
  total: "260.00",
  uncertainFields: [], billTo: "Industrial & Commercial Facilities Management Pte Ltd", site: null, servicePeriod: null, serviceRecords: [], otherInvoicesInFile: [],
};
const textract = (fields: Partial<TextractRead["fields"]>, error: string | null = null, skippedPages = 0): TextractRead => ({
  by: "textract",
  pages: 1,
  skippedPages,
  error,
  fields: { invoiceNumber: null, poNumber: null, subtotal: null, tax: null, total: null, totalFrom: null, gstRegNo: null, supplierName: null, ...fields },
});
const check0 = (t: TextractRead | null, inv: StandardInvoice = invoice) =>
  new CheckerService().run(inv, { supplier, po, alreadyRecorded: false, duplicateInBatch: null, readProblems: [], textract: t })[0];

describe("check 0 with Textract", () => {
  it("Textract and the AI agree → pass, and says what was confirmed", () => {
    const c = check0(textract({ invoiceNumber: "TBR-0457", total: "260.00", poNumber: "PO 2026 0103" }));
    assert.equal(c.status, "pass");
    assert.match(c.details.join(" "), /Textract agrees on invoice no\., PO, total/);
  });

  it("they disagree on the total → fail (one of them misread)", () => {
    const c = check0(textract({ invoiceNumber: "TBR-0457", total: "250.00" }));
    assert.equal(c.status, "fail");
    assert.match(c.details.join(" "), /total: the AI read 260\.00, Textract read 250\.00/);
  });

  it("they disagree on the invoice number → fail", () => {
    assert.equal(check0(textract({ invoiceNumber: "TBR-0451" })).status, "fail");
  });

  it("a printed sub-total after a discount still agrees", () => {
    const discounted = { ...invoice, subtotal: "1000.00", discounts: "50.00", total: "950.00", lines: [{ ...invoice.lines[0], quantity: "40", unitPrice: "25.00", amount: "1000.00" }] };
    assert.equal(check0(textract({ subtotal: "950.00", total: "950.00" }), discounted).status, "pass");
  });

  it("'amount due' differing from the total is a note, not a failure (deposit, balance b/f)", () => {
    assert.equal(check0(textract({ total: "160.00", totalFrom: "AMOUNT_DUE" })).status, "note");
  });

  it("a GST number matching the invoice's UEN counts as agreement", () => {
    assert.equal(check0(textract({ gstRegNo: "53312345A" })).status, "pass");
  });

  it("Textract couldn't read the file → a note, not a failure", () => {
    assert.equal(check0(textract({}, "Textract couldn't read it")).status, "note");
  });

  it("a page it couldn't read → a note, and the other pages' fields are still compared", () => {
    const c = check0(textract({ total: "250.00" }, "page 2: too large for Textract"));
    assert.equal(c.status, "fail", "the total from the readable pages disagrees");
    assert.match(c.details.join(" "), /page 2: too large/);
  });

  it("a note still shows what Textract confirmed", () => {
    const c = check0(textract({ invoiceNumber: "TBR-0457" }, "page 2: too large for Textract"));
    assert.equal(c.status, "note");
    assert.match(c.details.join(" "), /page 2: too large[\s\S]*Textract agrees on invoice no\./);
  });

  it("pages Textract didn't read → a note", () => {
    const c = check0(textract({ total: "260.00" }, null, 3));
    assert.equal(c.status, "note");
    assert.match(c.details.join(" "), /first 1 of 4 pages/);
  });

  it("no Textract result (spreadsheet, XML, or TEXTRACT=off) → unchanged", () => {
    assert.equal(check0(null).status, "pass");
  });
});
