import "reflect-metadata";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import type { AnalyzeExpenseCommandOutput } from "@aws-sdk/client-textract";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { CheckerService } from "../src/invoice-matching/checker/checker.service.js";
import { config } from "../src/invoice-matching/config.js";
import type { StandardInvoice } from "../src/invoice-matching/invoice.schema.js";
import { MatchingService } from "../src/invoice-matching/matching.service.js";
import { RetryableError } from "../src/invoice-matching/reader/extractor.js";
import type { Prepared } from "../src/invoice-matching/reader/file-prep.js";
import { ReaderService, pagesForTextract } from "../src/invoice-matching/reader/reader.service.js";
import { TextractReader } from "../src/invoice-matching/reader/textract.reader.js";

async function pdf(pages: ("text" | "scan")[]): Promise<Buffer> {
  const scan = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#ddd" } }).png().toBuffer();
  const doc = new PDFDocument({ size: "A4", margin: 50, autoFirstPage: false });
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  doc.pipe(out);
  for (const kind of pages) {
    doc.addPage();
    if (kind === "text") doc.fontSize(11).text("TAX INVOICE INV-1001 ".repeat(30));
    else doc.image(scan, 0, 0, { fit: [595, 842] });
  }
  doc.end();
  await once(out, "end");
  return Buffer.concat(chunks);
}

const invoice: StandardInvoice = {
  documentType: "invoice", supplier: { name: "X", uen: null, gstRegNo: null, address: null },
  bank: { accountHolder: null, accountNumber: null, swift: null }, invoiceNumber: "INV-1",
  invoiceDate: null, dueDate: null, poNumber: null, currency: "SGD", pricesIncludeTax: false,
  lines: [{ description: "x", quantity: "1", unitPrice: "10", amount: "10" }],
  subtotal: "10", tax: "0", fees: "0", discounts: "0", total: "10", uncertainFields: [], billTo: "Industrial & Commercial Facilities Management Pte Ltd", site: null, servicePeriod: null, serviceRecords: [], otherInvoicesInFile: [],
};

/** A ReaderService with a fake AI (records what it was given) and a fake Textract. */
function reader(textractAnswer: () => Promise<AnalyzeExpenseCommandOutput>, provider: "bedrock" | "local" = "bedrock") {
  const aiCalls: { prepared: Prepared; ocr: string | null | undefined }[] = [];
  let textractCalls = 0;
  const ai = {
    provider,
    model: "anthropic.claude-sonnet-5",
    extract: async (_file: string, prepared: Prepared, ocr?: string | null) => {
      aiCalls.push({ prepared, ocr });
      return invoice;
    },
  };
  const service = new ReaderService({} as never, { get: () => ai, defaultProvider: "bedrock" } as never);
  (service as unknown as { textract: TextractReader }).textract = new TextractReader(async () => {
    textractCalls++;
    return textractAnswer();
  }, 1000);
  return { service, aiCalls, textractCalls: () => textractCalls };
}

const onePage = async () =>
  ({ ExpenseDocuments: [{ SummaryFields: [], Blocks: [{ BlockType: "LINE", Id: "1", Text: "TOTAL S$ 10.00" }] }] }) as unknown as AnalyzeExpenseCommandOutput;

const photo = async () => sharp({ create: { width: 200, height: 300, channels: 3, background: "#fff" } }).jpeg().toBuffer();

const wasOn = config.textract.enabled;
after(() => {
  config.textract.enabled = wasOn;
});

describe("which pages Textract reads", () => {
  it("a photo: the photo", async () => {
    const pages = await pagesForTextract({ kind: "image", mediaType: "image/jpeg", data: Buffer.from("jpg") }, 5);
    assert.equal(pages?.images.length, 1);
  });

  it("a PDF: every page, computer-made or scanned", async () => {
    const pages = await pagesForTextract({ kind: "pdf", data: await pdf(["text", "scan"]) }, 5);
    assert.equal(pages?.images.length, 2);
    assert.equal(pages?.skippedPages, 0);
  });

  it("a long PDF: the first TEXTRACT_MAX_PAGES pages, and how many were left out", async () => {
    const pages = await pagesForTextract({ kind: "pdf", data: await pdf(["text", "text", "text"]) }, 2);
    assert.equal(pages?.images.length, 2);
    assert.equal(pages?.skippedPages, 1);
  });

  it("a 60-page PDF: still only the first pages, no 'too long' error (Claude reads the whole file)", async () => {
    const pages = await pagesForTextract({ kind: "pdf", data: await pdf(Array(60).fill("text")) }, 5);
    assert.equal(pages?.images.length, 5);
    assert.equal(pages?.skippedPages, 55);
  });

  it("a spreadsheet: nothing (no image)", async () => {
    assert.equal(await pagesForTextract({ kind: "text", text: "A1: INVOICE" }, 5), null);
  });
});

describe("Textract first, then the AI", () => {
  it("Textract's text goes to the AI with the file", async () => {
    config.textract.enabled = true;
    const { service, aiCalls } = reader(onePage);
    const r = await service.read("photo.jpg", await photo());
    assert.equal(aiCalls.length, 1);
    assert.equal(aiCalls[0].prepared.kind, "image");
    assert.equal(aiCalls[0].ocr, "TOTAL S$ 10.00");
    assert.equal(r.readBy, "bedrock");
    assert.equal(r.textract?.error, null);
  });

  it("Textract busy → the read fails as temporary and the AI isn't asked (no cost wasted)", async () => {
    config.textract.enabled = true;
    const { service, aiCalls } = reader(async () => {
      throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    });
    await assert.rejects(service.read("photo.jpg", await photo()), RetryableError);
    assert.equal(aiCalls.length, 0);
  });

  it("a spreadsheet goes to the AI without Textract", async () => {
    config.textract.enabled = true;
    const { service, aiCalls, textractCalls } = reader(onePage);
    await service.read("invoice.csv", Buffer.from("Invoice,INV-1\nTotal,10.00"));
    assert.equal(textractCalls(), 0);
    assert.equal(aiCalls[0].ocr, null);
  });

  it("the local LLM never gets Textract: nothing leaves this machine", async () => {
    config.textract.enabled = true;
    const { service, aiCalls, textractCalls } = reader(onePage, "local");
    const r = await service.read("photo.jpg", await photo());
    assert.equal(textractCalls(), 0);
    assert.equal(aiCalls[0].ocr, null);
    assert.equal(r.textract, null);
  });

  it("the same file again (queue retry, Read again): Textract isn't paid for twice", async () => {
    config.textract.enabled = true;
    const { service, aiCalls, textractCalls } = reader(onePage);
    const file = await photo();
    await service.read("photo.jpg", file);
    await service.read("photo.jpg", file);
    assert.equal(textractCalls(), 1);
    assert.equal(aiCalls[1].ocr, "TOTAL S$ 10.00");
  });

  it("Textract busy is not remembered: the retry asks Textract again", async () => {
    config.textract.enabled = true;
    let busy = true;
    const { service, textractCalls } = reader(async () => {
      if (busy) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      return onePage();
    });
    const file = await photo();
    await assert.rejects(service.read("photo.jpg", file), RetryableError);
    busy = false;
    const r = await service.read("photo.jpg", file);
    assert.equal(textractCalls(), 2);
    assert.equal(r.textract?.error, null);
  });

  it("a PDF that can't be turned into images: the AI still reads it, check 0 gets a note", async () => {
    config.textract.enabled = true;
    const { service, aiCalls, textractCalls } = reader(onePage);
    const r = await service.read("broken.pdf", Buffer.from("%PDF-1.7 not really a pdf"));
    assert.equal(textractCalls(), 0);
    assert.equal(aiCalls.length, 1);
    assert.match(r.textract?.error ?? "", /couldn't turn the PDF into page images/);
  });

  it("TEXTRACT=off: the AI reads the file alone", async () => {
    config.textract.enabled = false;
    const { service, aiCalls, textractCalls } = reader(onePage);
    const r = await service.read("photo.jpg", await photo());
    assert.equal(textractCalls(), 0);
    assert.equal(aiCalls[0].ocr, null);
    assert.equal(r.textract, null);
  });
});

describe("stored Textract results", () => {
  it("are ignored while TEXTRACT=off (re-check after switching it off)", async () => {
    config.textract.enabled = false;
    const accounting = { findSupplier: async () => null, findPo: async () => null, isAlreadyRecorded: async () => false, reload: async () => {} };
    const matching = new MatchingService(null as never, new CheckerService(), accounting as never);
    const stored = {
      invoice, readBy: "bedrock", model: "m", error: null, retryable: false, seconds: 1,
      textract: { by: "textract", pages: 1, skippedPages: 0, error: null, fields: { invoiceNumber: "INV-999", poNumber: null, subtotal: null, tax: null, total: null, totalFrom: null, gstRegNo: null, supplierName: null } },
    };
    const r = await matching.check("a.jpg", "h", stored as never, { byHash: new Map(), byKey: new Map(), byPo: new Map() });
    assert.equal(r.checks.find((c) => c.id === 0)!.status, "pass", "the stored disagreement must not count while Textract is off");
  });
});
