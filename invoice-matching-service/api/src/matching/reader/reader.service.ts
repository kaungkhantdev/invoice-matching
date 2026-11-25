import { createHash } from "node:crypto";
import { extname } from "node:path";
import { Injectable } from "@nestjs/common";
import { config } from "../../config.js";
import type { ReadBy, StandardInvoice } from "../invoice.schema.js";
import type { PoRead } from "../po.schema.js";
import { BedrockReader } from "./bedrock.reader.js";
import { prepareForAi, type Prepared } from "./file-prep.js";
import { pdfPageImages } from "./pdf.js";
import { TextractReader, textractProblem, type TextractOutput, type TextractRead } from "./textract.reader.js";
import { XmlReader } from "./xml.reader.js";

/** One file read: our standard invoice, who read it, and what Textract found (to compare in check 0). */
export interface ReadOutcome {
  invoice: StandardInvoice;
  readBy: ReadBy;
  model: string | null;
  textract: TextractRead | null;
}

/** pdf.js's own errors for a file it can't open: not a PDF, damaged, or password-protected. */
const UNREADABLE_PDF_ERRORS = new Set([
  "InvalidPDFException",
  "PasswordException",
  "MissingPDFException",
  "FormatError",
  "UnknownErrorException",
]);

/**
 * READ step: any file in, OUR standard invoice out.
 *   XML (InvoiceNow)          → read directly, no AI, no OCR
 *   PDF / photo / scan / SVG  → 1. Amazon Textract reads the text (OCR)
 *                               2. Claude on Bedrock copies it into our structure, from the file + Textract's text
 *   Excel / CSV               → Claude on Bedrock reads the cells (no image, so no Textract)
 */
@Injectable()
export class ReaderService {
  /** Replaced with stand-ins in tests. */
  bedrock = new BedrockReader();
  textract = new TextractReader();

  constructor(private readonly xml: XmlReader) {}

  /** Any supported file → our standard invoice, by the steps above. */
  async read(fileName: string, data: Buffer): Promise<ReadOutcome> {
    const extension = extensionOf(fileName);
    if (extension === ".xml") {
      return { invoice: this.xml.parse(data.toString("utf8")), readBy: "xml", model: null, textract: null };
    }
    const prepared = await prepareForAi(extension, data);
    // Textract first: its text goes to Bedrock. If Textract is busy, this throws and the queue tries again later.
    const ocr = await this.readText(prepared, data);
    const invoice = await this.bedrock.read(fileName, prepared, ocr?.text ?? null);
    return { invoice, readBy: "bedrock", model: this.bedrock.model, textract: ocr?.read ?? null };
  }

  /**
   * Screenshots (or a PDF printout) of one PO page from our system → the PO as shown. Claude only:
   * the page is clear screen text, and the checks add up its lines and grand total instead of Textract.
   */
  async readPo(files: { name: string; data: Buffer }[]): Promise<{ po: PoRead; model: string }> {
    const prepared = await Promise.all(
      files.map(async (file) => {
        // Say which of the screenshots is broken, so the right one can be taken again.
        const ready = await prepareForAi(extensionOf(file.name), file.data).catch((error: unknown) => {
          throw new Error(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        });
        return { name: file.name, prepared: ready };
      }),
    );
    return { po: await this.bedrock.readPo(prepared), model: this.bedrock.model };
  }

  /** e.g. "Bedrock anthropic.claude-sonnet-5 (ap-southeast-1) + Textract (ap-southeast-1)" — for the command line. */
  describe(): string {
    return `Bedrock ${this.bedrock.model} (${config.bedrock.region}) + Textract (${config.textract.region})`;
  }

  /** Textract's read of the file's pages, or null when the file has no pages to read (spreadsheet, CSV). */
  private async readText(prepared: Prepared, data: Buffer): Promise<TextractOutput | null> {
    let pages: { images: Buffer[]; skippedPages: number } | null;
    try {
      pages = await pagesForTextract(prepared, config.textract.maxPages);
    } catch (error) {
      // A broken or password-protected PDF: Bedrock still reads the file itself, check 0 gets a note.
      // Anything else (e.g. the image library missing on the server) is a real fault: let it show.
      if (!isUnreadablePdf(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      return textractProblem(`couldn't turn the PDF into page images (${reason})`);
    }
    if (!pages) return null;
    // The file's fingerprint lets Textract reuse pages it already read (queue retry, "Read again", a copy).
    const fileKey = createHash("sha256").update(data).digest("hex");
    return this.textract.read(pages.images, pages.skippedPages, fileKey);
  }
}

/** "Scan.PDF" → ".pdf" */
const extensionOf = (fileName: string) => extname(fileName).toLowerCase();

function isUnreadablePdf(error: unknown): boolean {
  return error instanceof Error && UNREADABLE_PDF_ERRORS.has(error.name);
}

/** What Textract reads: the photo, or the PDF's pages as images. Spreadsheets and CSV: nothing (no image). */
export async function pagesForTextract(
  prepared: Prepared,
  maxPages: number,
): Promise<{ images: Buffer[]; skippedPages: number } | null> {
  if (prepared.kind === "image") return { images: [prepared.data], skippedPages: 0 };
  if (prepared.kind === "pdf") return pdfPageImages(prepared.data, maxPages);
  return null;
}
