import "reflect-metadata";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { AnalyzeExpenseCommandOutput } from "@aws-sdk/client-textract";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import type { StandardInvoice } from "../src/matching/invoice.schema.js";
import { RetryableError } from "../src/matching/reader/errors.js";
import type { Prepared } from "../src/matching/reader/file-prep.js";
import { ReaderService, pagesForTextract } from "../src/matching/reader/reader.service.js";
import { TextractReader } from "../src/matching/reader/textract.reader.js";

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

/** A ReaderService with a stand-in Bedrock (records what it was given) and a stand-in Textract. */
function reader(textractAnswer: () => Promise<AnalyzeExpenseCommandOutput>) {
  const aiCalls: { prepared: Prepared; ocr: string | null }[] = [];
  let textractCalls = 0;
  const service = new ReaderService({} as never);
  service.bedrock = {
    model: "anthropic.claude-sonnet-5",
    read: async (_file: string, prepared: Prepared, ocr: string | null) => {
      aiCalls.push({ prepared, ocr });
      return invoice;
    },
  } as never;
  service.textract = new TextractReader(async () => {
    textractCalls++;
    return textractAnswer();
  }, 1000);
  return { service, aiCalls, textractCalls: () => textractCalls };
}

const onePage = async () =>
  ({ ExpenseDocuments: [{ SummaryFields: [], Blocks: [{ BlockType: "LINE", Id: "1", Text: "TOTAL S$ 10.00" }] }] }) as unknown as AnalyzeExpenseCommandOutput;

const photo = async () => sharp({ create: { width: 200, height: 300, channels: 3, background: "#fff" } }).jpeg().toBuffer();

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

describe("Textract first, then Bedrock", () => {
  it("Textract's text goes to Bedrock with the file", async () => {
    const { service, aiCalls } = reader(onePage);
    const r = await service.read("photo.jpg", await photo());
    assert.equal(aiCalls.length, 1);
    assert.equal(aiCalls[0].prepared.kind, "image");
    assert.equal(aiCalls[0].ocr, "TOTAL S$ 10.00");
    assert.equal(r.readBy, "bedrock");
    assert.equal(r.textract?.error, null);
  });

  it("Textract busy → the read fails as temporary and Bedrock isn't asked (no cost wasted)", async () => {
    const { service, aiCalls } = reader(async () => {
      throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    });
    await assert.rejects(service.read("photo.jpg", await photo()), RetryableError);
    assert.equal(aiCalls.length, 0);
  });

  it("a spreadsheet goes to Bedrock without Textract", async () => {
    const { service, aiCalls, textractCalls } = reader(onePage);
    await service.read("invoice.csv", Buffer.from("Invoice,INV-1\nTotal,10.00"));
    assert.equal(textractCalls(), 0);
    assert.equal(aiCalls[0].ocr, null);
  });

  it("the same file again (queue retry, Read again): Textract isn't paid for twice", async () => {
    const { service, aiCalls, textractCalls } = reader(onePage);
    const file = await photo();
    await service.read("photo.jpg", file);
    await service.read("photo.jpg", file);
    assert.equal(textractCalls(), 1);
    assert.equal(aiCalls[1].ocr, "TOTAL S$ 10.00");
  });

  it("Textract busy is not remembered: the retry asks Textract again", async () => {
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

  it("a PDF that can't be turned into images: Bedrock still reads it, check 0 gets a note", async () => {
    const { service, aiCalls, textractCalls } = reader(onePage);
    const r = await service.read("broken.pdf", Buffer.from("%PDF-1.7 not really a pdf"));
    assert.equal(textractCalls(), 0);
    assert.equal(aiCalls.length, 1);
    assert.match(r.textract?.error ?? "", /couldn't turn the PDF into page images/);
  });
});
