import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { config, type AiProvider } from "../config.js";
import type { ReadBy, StandardInvoice } from "../invoice.schema.js";
import { ExtractorRegistry } from "./extractor.registry.js";
import { prepareForAi, type Prepared } from "./file-prep.js";
import { pdfPageImages } from "./pdf.js";
import { TextractReader, textractProblem, type TextractOutput, type TextractRead } from "./textract.reader.js";
import { XmlReader } from "./xml.reader.js";

/**
 * READ step: any file in, OUR standard invoice out.
 *   XML (InvoiceNow)                → read directly, no AI, no OCR
 *   PDF / photo / scan / SVG        → 1. Amazon Textract reads the text (OCR)
 *                                     2. Claude on Bedrock (AI_PROVIDER) copies it into our structure,
 *                                        looking at the file and Textract's text together
 *   Excel / CSV                     → the AI reads the cells (no image, so no Textract)
 * The local LLM never gets Textract: with it, nothing leaves this machine.
 */
@Injectable()
export class ReaderService {
  private readonly textract = new TextractReader();

  constructor(
    private readonly xml: XmlReader,
    private readonly extractors: ExtractorRegistry,
  ) {}

  /** e.g. "Bedrock anthropic.claude-sonnet-5 + Textract" — for logs and reports. */
  describeAi(provider: AiProvider = this.extractors.defaultProvider): string {
    const ai = this.extractors.get(provider);
    const name = { bedrock: "Bedrock", claude: "Claude API", local: "local LLM" }[ai.provider];
    return `${name} ${ai.model}${usesTextract(ai.provider) ? " + Textract" : ""}`;
  }

  async read(
    fileName: string,
    data: Buffer,
    provider?: AiProvider,
  ): Promise<{ invoice: StandardInvoice; readBy: ReadBy; model: string | null; textract: TextractRead | null }> {
    const ext = extname(fileName).toLowerCase();
    if (ext === ".xml") {
      return { invoice: this.xml.parse(data.toString("utf8")), readBy: "xml", model: null, textract: null };
    }
    const ai = this.extractors.get(provider);
    const prepared = await prepareForAi(ext, data);
    // Textract first: its text goes to the AI. If Textract is busy, this throws and the queue tries again later.
    const ocr = usesTextract(ai.provider) ? await this.readText(prepared, data) : null;
    const invoice = await ai.extract(fileName, prepared, ocr?.text ?? null);
    return { invoice, readBy: ai.provider, model: ai.model, textract: ocr?.read ?? null };
  }

  private async readText(prepared: Prepared, data: Buffer): Promise<TextractOutput | null> {
    let pages: { images: Buffer[]; skippedPages: number } | null;
    try {
      pages = await pagesForTextract(prepared, config.textract.maxPages);
    } catch (error) {
      // A broken or password-protected PDF: the AI still reads the file itself, check 0 gets a note.
      // Anything else (e.g. the image library missing on the server) is a real fault: let it show.
      if (!isUnreadablePdf(error)) throw error;
      return textractProblem(`couldn't turn the PDF into page images (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!pages) return null;
    // The file's fingerprint lets Textract reuse pages it already read (queue retry, "Read again", a copy).
    const fileKey = createHash("sha256").update(data).digest("hex");
    return this.textract.read(pages.images, pages.skippedPages, fileKey);
  }
}

/** pdf.js's own errors for a file it can't open: not a PDF, damaged, or password-protected. */
const isUnreadablePdf = (error: unknown) =>
  error instanceof Error && /^(InvalidPDFException|PasswordException|MissingPDFException|FormatError|UnknownErrorException)$/.test(error.name);

/** Textract is on, and the AI isn't the local one (with a local LLM, invoices stay on this machine). */
export const usesTextract = (provider: AiProvider) => config.textract.enabled && provider !== "local";

/** What Textract reads: the photo, or the PDF's pages as images. Spreadsheets and CSV: nothing (no image). */
export async function pagesForTextract(
  prepared: Prepared,
  maxPages: number,
): Promise<{ images: Buffer[]; skippedPages: number } | null> {
  if (prepared.kind === "image") return { images: [prepared.data], skippedPages: 0 };
  if (prepared.kind === "pdf") return pdfPageImages(prepared.data, maxPages);
  return null;
}
