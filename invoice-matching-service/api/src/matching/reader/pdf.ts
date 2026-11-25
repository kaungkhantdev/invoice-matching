import { getDocumentProxy, renderPageAsImage } from "unpdf";
import { photo } from "./file-prep.js";

/**
 * The first `maxPages` pages as JPEG images, for Textract (its quick API reads one image per request).
 * Every page, computer-made or scanned, so Textract sees the same document the AI sees.
 */
export async function pdfPageImages(
  pdf: Buffer,
  maxPages: number,
): Promise<{ images: Buffer[]; skippedPages: number }> {
  const pdfDocument = await getDocumentProxy(new Uint8Array(pdf));
  try {
    // Only the first pages are rendered, so a long PDF is fine here (Claude still reads the whole file).
    const count = Math.min(pdfDocument.numPages, Math.max(1, maxPages));
    const images: Buffer[] = [];
    for (let page = 1; page <= count; page++) {
      // ~170 dpi after photo() (A4 → 2000 px tall): small print stays above Textract's 15 px minimum text height.
      const jpeg = await renderPageAsImage(pdfDocument, page, {
        canvasImport: () => import("@napi-rs/canvas"),
        scale: 2.5,
        format: "jpeg",
        quality: 0.9,
      });
      images.push(await photo(Buffer.from(jpeg)));
    }
    return { images, skippedPages: pdfDocument.numPages - count };
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

/** Number of pages, for the preview. */
export async function pdfPageCount(pdf: Buffer): Promise<number> {
  const pdfDocument = await getDocumentProxy(new Uint8Array(pdf));
  try {
    return pdfDocument.numPages;
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}

/** One page as a JPEG, for the preview. A page number out of range shows the nearest page. */
export async function renderPdfPage(pdf: Buffer, page: number): Promise<Buffer> {
  const pdfDocument = await getDocumentProxy(new Uint8Array(pdf));
  try {
    const pageNumber = Math.min(Math.max(1, page), pdfDocument.numPages);
    const jpeg = await renderPageAsImage(pdfDocument, pageNumber, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale: 1.6,
      format: "jpeg",
      quality: 0.85,
    });
    return Buffer.from(jpeg);
  } finally {
    await pdfDocument.loadingTask.destroy();
  }
}
