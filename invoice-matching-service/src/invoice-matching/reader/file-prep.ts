import ExcelJS from "exceljs";
import heicConvert from "heic-convert";
import JSZip from "jszip";
import sharp from "sharp";

/** What we send to the AI: a PDF, an image, or plain text. */
export type Prepared =
  | { kind: "pdf"; data: Buffer }
  | { kind: "image"; mediaType: "image/jpeg"; data: Buffer }
  | { kind: "text"; text: string };

const MAX_SIDE = 2000;

/** Phone photos: fix rotation (EXIF), shrink very large images, save as JPEG. */
export async function photo(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Larger than any real invoice; protects the server from spreadsheets built to use up all memory. */
const MAX_SHEET_CELLS = 200_000;
const MAX_SHEET_XML_BYTES = 50 * 1024 * 1024;

function columnNumber(letters: string): number {
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

/**
 * Look inside the .xlsx before opening it. A few-KB file can declare a merged range of millions of cells,
 * which the spreadsheet library expands one by one until the server runs out of memory.
 */
async function assertSafeWorkbook(input: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(input);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (size > MAX_SHEET_XML_BYTES) throw new Error("Spreadsheet is far too large for an invoice");
    const xml = await entry.async("string");
    // Only merged ranges are expanded cell by cell. (<dimension> can legitimately be huge, so it isn't checked.)
    for (const m of xml.matchAll(/<mergeCell\b[^>]*\bref="\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)"/g)) {
      const cells = (Math.abs(columnNumber(m[3]) - columnNumber(m[1])) + 1) * (Math.abs(Number(m[4]) - Number(m[2])) + 1);
      if (cells > MAX_SHEET_CELLS) throw new Error(`Spreadsheet covers ${cells.toLocaleString()} cells: too large for an invoice`);
    }
  }
}

/** Excel: every non-empty cell as "A1: value", sheet by sheet, so the AI sees the layout. */
export async function excelToText(input: Buffer): Promise<string> {
  await assertSafeWorkbook(input);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(input as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    out.push(`## Sheet: ${ws.name}`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (c) => {
        if (c.text.trim() !== "") cells.push(`${c.address}: ${c.text}`);
      });
      if (cells.length) out.push(cells.join(" | "));
    });
  });
  return out.join("\n");
}

export const SUPPORTED = [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".svg", ".xlsx", ".csv", ".txt"];

export async function prepareForAi(ext: string, input: Buffer): Promise<Prepared> {
  switch (ext) {
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
      throw new Error(`Unsupported file type "${ext}"`);
  }
}
