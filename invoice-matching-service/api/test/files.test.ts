import assert from "node:assert/strict";
import { describe, it } from "node:test";
import JSZip from "jszip";
import { excelToText } from "../src/matching/reader/file-prep.js";

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
