/// <reference types="multer" />
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UnprocessableEntityException,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { prepareForAi } from "../matching/reader/file-prep.js";
import { renderPdfPage } from "../matching/reader/pdf.js";
import { InvoiceStore, MAX_FILE_BYTES, MAX_PO_FILES } from "./invoice-store.service.js";
import { IMAGE_KINDS, INLINE_TYPES, toDetail, toSummary } from "./invoice.view.js";

/** Uploads go to a temporary folder on disk (not memory). */
const UPLOAD_DIR = join(tmpdir(), "invoice-matching-uploads");

interface DecisionBody {
  decision?: string;
  note?: string;
  /** The result the page showed when the person decided. */
  outcome?: string;
}

/**
 * Invoices: upload one with its PO (the only way in), list, detail, the original files, preview images, read again,
 * approve / reject, re-check.
 */
@Controller()
export class InvoicesController {
  constructor(private readonly store: InvoiceStore) {}

  @Get("invoices")
  list() {
    return this.store.list().map(toSummary);
  }

  @Get("invoices/:id")
  detail(@Param("id") id: string) {
    const entry = this.store.get(id);
    return toDetail(entry, this.store.filePath(entry), this.store.poFilePaths(entry));
  }

  /** The original file (PDFs and photos open in the page; other types download). */
  @Get("invoices/:id/file")
  async file(@Param("id") id: string, @Res() response: Response) {
    const entry = this.store.get(id);
    await sendOriginal(response, entry.file, entry.ext, this.store.filePath(entry));
  }

  /**
   * A safe JPEG of the file for the page: photos, HEIC and SVG (straightened, like Bedrock sees them),
   * and PDF pages (?page=1, 2, …). Works in every browser, with no PDF plug-in needed.
   */
  @Get("invoices/:id/preview")
  async preview(@Param("id") id: string, @Query("page") page: string | undefined, @Res() response: Response) {
    const entry = this.store.get(id);
    await sendPreview(response, entry.ext, this.store.filePath(entry), page);
  }

  /** PO file n (1, 2, …) uploaded with the invoice, as uploaded. */
  @Get("invoices/:id/po/:n/file")
  async poFile(@Param("id") id: string, @Param("n") n: string, @Res() response: Response) {
    const { file, ext, path } = this.store.poFile(this.store.get(id), n);
    await sendOriginal(response, file, ext, path);
  }

  /** PO file n as a JPEG (a PDF printout: ?page=1, 2, …). */
  @Get("invoices/:id/po/:n/preview")
  async poPreview(
    @Param("id") id: string,
    @Param("n") n: string,
    @Query("page") page: string | undefined,
    @Res() response: Response,
  ) {
    const { ext, path } = this.store.poFile(this.store.get(id), n);
    await sendPreview(response, ext, path, page);
  }

  /**
   * One supplier invoice with its PO: `po` = 1 to 5 screenshots (or a PDF printout) of the PO page in our system,
   * `invoice` = the supplier's invoice. The invoice is checked against that PO instead of the POs in data/.
   */
  @Post("invoices/with-po")
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "po", maxCount: MAX_PO_FILES },
        { name: "invoice", maxCount: 1 },
      ],
      { dest: UPLOAD_DIR, limits: { fileSize: MAX_FILE_BYTES, files: MAX_PO_FILES + 1 } },
    ),
  )
  async uploadWithPo(@UploadedFiles() files: { po?: Express.Multer.File[]; invoice?: Express.Multer.File[] } = {}) {
    const entry = await this.store.addWithPo((files.po ?? []).map(incoming), (files.invoice ?? []).map(incoming));
    return { added: [toSummary(entry)], skipped: [] };
  }

  @Post("invoices/:id/reread")
  reread(@Param("id") id: string) {
    return toSummary(this.store.reread(id));
  }

  @Post("invoices/:id/decision")
  decide(@Param("id") id: string, @Body() body: DecisionBody) {
    if (body.decision !== "APPROVED" && body.decision !== "REJECTED") {
      throw new BadRequestException('decision must be "APPROVED" or "REJECTED"');
    }
    const note = String(body.note ?? "");
    const outcomeSeen = body.outcome ? String(body.outcome) : undefined;
    return toSummary(this.store.decide(id, body.decision, note, outcomeSeen));
  }

  /** Reload suppliers and POs from the data folder and run the checks again (no AI). */
  @Post("recheck")
  async recheck() {
    try {
      await this.store.recheckAll();
    } catch (error) {
      // e.g. a typo in a data/ file: say which file, instead of a bare "Internal server error".
      const reason = error instanceof Error ? error.message : String(error);
      throw new UnprocessableEntityException(`Could not reload the data: ${reason}`);
    }
    return this.store.list().map(toSummary);
  }

  @Delete("invoices")
  @HttpCode(204)
  async clear() {
    await this.store.clear();
  }
}

/** An uploaded file as the store takes it. Browsers send UTF-8 names, which multer reads as latin1. */
function incoming(file: Express.Multer.File) {
  return { name: Buffer.from(file.originalname, "latin1").toString("utf8"), path: file.path };
}

/** The file as uploaded: PDFs and photos open in the browser; anything else only downloads. */
async function sendOriginal(response: Response, name: string, ext: string, path: string) {
  const inlineType = INLINE_TYPES[ext];
  const fileName = encodeURIComponent(name);
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (inlineType) {
    response.setHeader("Content-Type", inlineType);
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${fileName}`);
  } else {
    // SVG/XML can carry scripts: never render them on our page, only download.
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${fileName}`);
    response.setHeader("Content-Security-Policy", "sandbox");
  }
  response.send(await readFile(path));
}

/** A JPEG of the file: the picture, or one PDF page. */
async function sendPreview(response: Response, ext: string, path: string, page: string | undefined) {
  const jpeg = await previewJpeg(ext, await readFile(path), page);
  response.setHeader("Content-Type", "image/jpeg");
  response.setHeader("Cache-Control", "private, max-age=3600");
  response.send(jpeg);
}

/** PDF: the asked-for page (1 when missing or not a number). Pictures: straightened, as JPEG. */
async function previewJpeg(ext: string, data: Buffer, page: string | undefined): Promise<Buffer> {
  if (ext === ".pdf") return renderPdfPage(data, Math.max(1, Number(page) || 1));
  if (!IMAGE_KINDS.has(ext)) throw new NotFoundException("No image preview for this file type");
  const prepared = await prepareForAi(ext, data);
  if (prepared.kind !== "image") throw new NotFoundException("No image preview for this file type");
  return prepared.data;
}
