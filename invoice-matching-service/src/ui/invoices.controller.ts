/// <reference types="multer" />
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
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiProvider } from "../invoice-matching/config.js";
import { ExtractorRegistry } from "../invoice-matching/reader/extractor.registry.js";
import { excelToText, prepareForAi } from "../invoice-matching/reader/file-prep.js";
import { pdfPageCount, renderPdfPage } from "../invoice-matching/reader/pdf.js";
import { InvoiceStore, MAX_FILE_BYTES, type Entry } from "./invoice-store.service.js";

/** One upload can carry a whole month of invoices. */
const MAX_FILES_PER_UPLOAD = 1000;

const IMAGE_KINDS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".svg"]);
const TEXT_KINDS = new Set([".xml", ".csv", ".txt", ".xlsx"]);
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function provider(value: unknown, fallback: AiProvider): AiProvider {
  return value === "claude" || value === "local" ? value : fallback;
}

/** The short row shown in the list. */
function summary(e: Entry) {
  const r = e.result;
  const inv = r?.invoice ?? null;
  const problems = r
    ? [
        ...(r.error ? [`Could not read: ${r.error}`] : []),
        ...r.checks.filter((c) => c.status === "fail" || c.status === "note").flatMap((c) => c.details),
      ]
    : [];
  return {
    id: e.id,
    seq: e.seq,
    file: e.file,
    state: e.state,
    provider: e.provider,
    outcome: e.state === "DONE" ? (r?.outcome ?? null) : null,
    supplier: inv?.supplier.name ?? null,
    invoiceNumber: inv?.invoiceNumber ?? null,
    poNumber: inv?.poNumber ?? null,
    currency: inv?.currency ?? null,
    total: inv?.total ?? null,
    readBy: r?.readBy ?? null,
    model: r?.model ?? null,
    seconds: e.read?.seconds ?? null,
    attempts: e.attempts,
    retryError: e.retryError,
    problems,
    decision: e.decision,
    updatedAt: e.updatedAt,
  };
}

/** The web UI's API. Runs on 127.0.0.1 only (see server.ts). */
@Controller("api")
export class InvoicesController {
  constructor(
    private readonly store: InvoiceStore,
    private readonly extractors: ExtractorRegistry,
  ) {}

  @Get("status")
  async status() {
    return {
      defaultProvider: this.extractors.defaultProvider,
      providers: await this.extractors.status(),
      queue: this.store.queueStats(),
    };
  }

  @Get("invoices")
  list() {
    return this.store.list().map(summary);
  }

  @Get("invoices/:id")
  async detail(@Param("id") id: string) {
    const e = this.store.get(id);
    let previewKind: "image" | "pages" | "text" | "none" = "none";
    let previewText: string | null = null;
    let pages = 0;
    if (e.ext === ".pdf") {
      previewKind = "pages";
      pages = Math.min(10, await pdfPageCount(await readFile(this.store.filePath(e))).catch(() => 0));
    } else if (IMAGE_KINDS.has(e.ext)) previewKind = "image";
    else if (TEXT_KINDS.has(e.ext)) {
      try {
        const data = await readFile(this.store.filePath(e));
        previewText = e.ext === ".xlsx" ? await excelToText(data) : data.toString("utf8");
        if (previewText.length > 60_000) previewText = `${previewText.slice(0, 60_000)}\n…`;
        previewKind = "text";
      } catch {
        // e.g. a password-protected or broken spreadsheet: just no preview.
      }
    }
    return { ...summary(e), addedAt: e.addedAt, size: e.size, result: e.result, error: e.read?.error ?? null, previewKind, previewText, pages };
  }

  /** The original file (PDFs and photos open in the page; other types download). */
  @Get("invoices/:id/file")
  async file(@Param("id") id: string, @Res() res: Response) {
    const e = this.store.get(id);
    const type = CONTENT_TYPES[e.ext];
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (type) {
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(e.file)}`);
    } else {
      // SVG/XML can carry scripts: never render them on our page, only download.
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(e.file)}`);
      res.setHeader("Content-Security-Policy", "sandbox");
    }
    res.send(await readFile(this.store.filePath(e)));
  }

  /**
   * A safe JPEG of the file for the page: photos, HEIC and SVG (straightened, like the AI sees them),
   * and PDF pages (?page=1, 2, …). Works in every browser, with no PDF plug-in needed.
   */
  @Get("invoices/:id/preview")
  async preview(@Param("id") id: string, @Query("page") page: string | undefined, @Res() res: Response) {
    const e = this.store.get(id);
    const data = await readFile(this.store.filePath(e));
    let jpeg: Buffer;
    if (e.ext === ".pdf") {
      jpeg = await renderPdfPage(data, Math.max(1, Number(page) || 1));
    } else if (IMAGE_KINDS.has(e.ext)) {
      const prepared = await prepareForAi(e.ext, data);
      if (prepared.kind !== "image") throw new NotFoundException("No image preview for this file type");
      jpeg = prepared.data;
    } else {
      throw new NotFoundException("No image preview for this file type");
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(jpeg);
  }

  @Post("invoices")
  @UseInterceptors(
    // Uploads go to a temporary folder on disk (not memory), so a month of invoices at once is fine.
    FilesInterceptor("files", MAX_FILES_PER_UPLOAD, {
      dest: join(tmpdir(), "invoice-matching-uploads"),
      limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD },
    }),
  )
  async upload(@UploadedFiles() files: Express.Multer.File[] | undefined, @Body("provider") chosen?: string) {
    if (!files?.length) throw new BadRequestException("No files received");
    const { added, skipped } = await this.store.add(
      // Browsers send UTF-8 names, which multer reads as latin1.
      files.map((f) => ({ name: Buffer.from(f.originalname, "latin1").toString("utf8"), path: f.path })),
      provider(chosen, this.extractors.defaultProvider),
    );
    return { added: added.map(summary), skipped };
  }

  @Post("samples")
  async samples(@Body("provider") chosen?: string) {
    const { added, skipped } = await this.store.addSamples(provider(chosen, this.extractors.defaultProvider));
    return { added: added.map(summary), skipped };
  }

  @Post("invoices/:id/reread")
  reread(@Param("id") id: string, @Body("provider") chosen?: string) {
    return summary(this.store.reread(id, provider(chosen, this.extractors.defaultProvider)));
  }

  @Post("invoices/:id/decision")
  decide(@Param("id") id: string, @Body() body: { decision?: string; note?: string }) {
    if (body.decision !== "APPROVED" && body.decision !== "REJECTED") {
      throw new BadRequestException('decision must be "APPROVED" or "REJECTED"');
    }
    return summary(this.store.decide(id, body.decision, String(body.note ?? "")));
  }

  /** Reload suppliers and POs from data/ and run the checks again (no AI). */
  @Post("recheck")
  async recheck() {
    await this.store.recheckAll();
    return this.store.list().map(summary);
  }

  @Delete("invoices")
  @HttpCode(204)
  async clear() {
    await this.store.clear();
  }
}
