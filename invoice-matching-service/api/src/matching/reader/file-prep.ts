import ExcelJS from "exceljs";
import heicConvert from "heic-convert";
import JSZip from "jszip";
import sharp from "sharp";

/** What we send to the AI: a PDF, an image, or plain text. */
export type Prepared =
  | { kind: "pdf"; data: Buffer }
  | { kind: "image"; mediaType: "image/jpeg"; data: Buffer }
  | { kind: "text"; text: string };

/** File types prepareForAi can turn into what the AI reads (XML e-invoices are read without the AI). */
export const SUPPORTED = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".heic",
  ".heif",
  ".svg",
  ".xlsx",
  ".csv",
  ".txt",
];

/** Images larger than this (longest side, in pixels) are shrunk to it. */
const MAX_SIDE = 2000;

/** Larger than any real invoice; protects the server from spreadsheets built to use up all memory. */
const MAX_SHEET_CELLS = 200_000;
const MAX_SHEET_XML_BYTES = 50 * 1024 * 1024;

/** A merged range in a sheet's XML, e.g. <mergeCell ref="A1:C3"/> (the $ of absolute references allowed). */
const MERGED_RANGE = /<mergeCell\b[^>]*\bref="\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)"/g;

/** A file as the AI reads it. `extension` is lower case, with its dot, e.g. ".pdf". */
export async function prepareForAi(extension: string, input: Buffer): Promise<Prepared> {
  switch (extension) {
    case ".pdf":
      return { kind: "pdf", data: input };
    case ".jpg":
    case ".jpeg":
    case ".png":
    case ".webp":
    case ".gif":
      return { kind: "image", mediaType: "image/jpeg", data: await photo(input) };
    case ".heic":
    case ".heif": {
      const jpeg = await heicConvert({ buffer: input, format: "JPEG", quality: 0.9 });
      return { kind: "image", mediaType: "image/jpeg", data: await photo(Buffer.from(jpeg)) };
    }
    case ".svg": {
      const png = await sharp(input, { density: 150 }).png().toBuffer();
      return { kind: "image", mediaType: "image/jpeg", data: await photo(png) };
    }
    case ".xlsx":
      return { kind: "text", text: await excelToText(input) };
    case ".csv":
    case ".txt":
      return { kind: "text", text: input.toString("utf8") };
    case ".xls":
      throw new Error("Old .xls format: please save it as .xlsx");
    default:
      throw new Error(`Unsupported file type "${extension}"`);
  }
}

/** Phone photos: fix rotation (EXIF), shrink very large images, save as JPEG. */
export async function photo(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Excel: every non-empty cell as "A1: value", sheet by sheet, so the AI sees the layout. */
export async function excelToText(input: Buffer): Promise<string> {
  await assertSafeWorkbook(input);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input as unknown as ArrayBuffer);
  const lines: string[] = [];
  workbook.eachSheet((sheet) => {
    lines.push(`## Sheet: ${sheet.name}`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.text.trim() !== "") cells.push(`${cell.address}: ${cell.text}`);
      });
      if (cells.length) lines.push(cells.join(" | "));
    });
  });
  return lines.join("\n");
}

/**
 * Look inside the .xlsx before opening it. A few-KB file can declare a merged range of millions of cells,
 * which the spreadsheet library expands one by one until the server runs out of memory.
 */
async function assertSafeWorkbook(input: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(input);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
    // JSZip keeps the unzipped size in a private field: read it before unzipping anything.
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (size > MAX_SHEET_XML_BYTES) throw new Error("Spreadsheet is far too large for an invoice");
    const xml = await entry.async("string");
    // Only merged ranges are expanded cell by cell. (<dimension> can legitimately be huge, so it isn't checked.)
    for (const range of xml.matchAll(MERGED_RANGE)) {
      const cells = mergedCellCount(range);
      if (cells > MAX_SHEET_CELLS) {
        throw new Error(`Spreadsheet covers ${cells.toLocaleString()} cells: too large for an invoice`);
      }
    }
  }
}

/** Cells in a merged range such as A1:C3 (9), whichever corner is written first. */
function mergedCellCount(range: RegExpMatchArray): number {
  const [, fromColumn, fromRow, toColumn, toRow] = range;
  const columns = Math.abs(columnNumber(toColumn) - columnNumber(fromColumn)) + 1;
  const rows = Math.abs(Number(toRow) - Number(fromRow)) + 1;
  return columns * rows;
}

/** "A" → 1, "Z" → 26, "AA" → 27. */
function columnNumber(letters: string): number {
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}
