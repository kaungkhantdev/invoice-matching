import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import { excelToText } from "../src/invoice-matching/reader/file-prep.js";
import { pdfForLocalLlm } from "../src/invoice-matching/reader/pdf.js";

async function makePdf(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  doc.pipe(out);
  draw(doc);
  doc.end();
  await once(out, "end");
  return Buffer.concat(chunks);
}

describe("spreadsheet safety", () => {
  it("refuses a tiny .xlsx whose merged range would fill the memory", async () => {
    const zip = new JSZip();
    zip.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData/><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>',
    );
    const bomb = await zip.generateAsync({ type: "nodebuffer" });
    assert.ok(bomb.length < 2000);
    await assert.rejects(excelToText(bomb), /too large/);
  });
});

describe("spreadsheet safety: normal files still open", () => {
  it("a sheet that declares a huge <dimension> (some programs do) is not refused", async () => {
    const zip = new JSZip();
    zip.file("xl/worksheets/sheet1.xml", '<worksheet><dimension ref="A1:XFD1048576"/><sheetData/></worksheet>');
    // Not a complete workbook, so the spreadsheet library itself may still fail. It must not be our size guard.
    await excelToText(await zip.generateAsync({ type: "nodebuffer" })).catch((error: Error) => {
      assert.doesNotMatch(error.message, /too large/);
    });
  });
});

describe("PDF for a local LLM", () => {
  it("the sample computer-made PDF is sent as text only", async () => {
    const r = await pdfForLocalLlm(await readFile("samples/invoices/02-kallang-packaging-KP-88131.pdf"), 5);
    assert.equal(r.images.length, 0);
    assert.match(r.text ?? "", /KP-GB-M\s+Gift Box \(Medium\)\s+100\s+2\.60\s+260\.00/);
  });

  it("a page with only a short stamp (like a scan with an 'approved' stamp) is also sent as an image", async () => {
    const pdf = await makePdf((doc) => {
      doc.fontSize(12).text("APPROVED 06/11/2026 Accounts Payable");
    });
    const r = await pdfForLocalLlm(pdf, 5);
    assert.equal(r.images.length, 1);
    assert.match(r.text ?? "", /APPROVED/);
  });
});
