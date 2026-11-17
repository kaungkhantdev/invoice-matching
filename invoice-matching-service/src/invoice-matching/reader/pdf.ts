import { extractTextItems, getDocumentProxy, renderPageAsImage } from "unpdf";
import { photo } from "./file-prep.js";

/**
 * What a local LLM gets for a PDF, decided page by page:
 * pages with a text layer are sent as text, scanned pages (pictures only) as images.
 */
export interface PdfForLlm {
  text: string | null;
  images: Buffer[];
  totalPages: number;
  /** Scanned pages not turned into images because of the page limit. */
  skippedPages: number;
}

/**
 * A page with fewer letters/digits than this is also sent as an image. Scans often carry a little real
 * text (an "approved" stamp, a copier header) that would otherwise make them look like text pages.
 */
const MIN_READABLE_CHARS_TEXT_ONLY = 200;
/** Invoices are short. Anything longer is almost certainly the wrong file. */
const MAX_PAGES = 50;

type Item = { str: string; x: number; y: number; width: number; fontSize: number };

/**
 * Rebuild the page as lines of text, left to right, top to bottom, with wide gaps kept as
 * extra spaces. Table rows stay on one line ("KP-GB-M  Gift Box (Medium)  100  2.60  260.00"),
 * which small local models read much better than loose words.
 */
export function layoutText(items: Item[]): string {
  const rows: { y: number; size: number; items: Item[] }[] = [];
  for (const item of items.filter((i) => i.str.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((r) => Math.abs(r.y - item.y) <= Math.max(2, Math.min(r.size, item.fontSize) * 0.5));
    if (row) row.items.push(item);
    else rows.push({ y: item.y, size: item.fontSize || 10, items: [item] });
  }
  return rows
    .map((row) => {
      const sorted = row.items.sort((a, b) => a.x - b.x);
      let line = "";
      let end = -Infinity;
      for (const item of sorted) {
        const gap = item.x - end;
        if (line !== "") line += gap > row.size * 1.5 ? "    " : gap > row.size * 0.15 ? " " : "";
        line += item.str.trim();
        end = item.x + item.width;
      }
      return line;
    })
    .join("\n");
}

export async function pdfForLocalLlm(pdf: Buffer, maxImagePages: number): Promise<PdfForLlm> {
  // A copy: pdf.js takes over (detaches) the memory it is given.
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  try {
    if (doc.numPages > MAX_PAGES) throw new Error(`PDF has ${doc.numPages} pages: too long for an invoice (limit ${MAX_PAGES})`);
    const { totalPages, items } = await extractTextItems(doc);

    const textPages: string[] = [];
    const scannedPages: number[] = [];
    for (const [i, pageItems] of items.entries()) {
      const text = layoutText(pageItems);
      const readable = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
      // Rotated pages (landscape via /Rotate): text positions come out sideways, so read the picture.
      const rotated = (await doc.getPage(i + 1)).rotate % 360 !== 0;
      if (readable > 0 && !rotated) textPages.push(totalPages > 1 ? `--- Page ${i + 1} of ${totalPages} ---\n${text}` : text);
      if (readable < MIN_READABLE_CHARS_TEXT_ONLY || rotated) scannedPages.push(i + 1);
    }

    const toRender = scannedPages.slice(0, Math.max(0, maxImagePages));
    const images: Buffer[] = [];
    for (const page of toRender) {
      const jpeg = await renderPageAsImage(doc, page, {
        canvasImport: () => import("@napi-rs/canvas"),
        scale: 2,
        format: "jpeg",
        quality: 0.9,
      });
      images.push(await photo(Buffer.from(jpeg)));
    }

    return {
      text: textPages.length ? textPages.join("\n\n") : null,
      images,
      totalPages,
      skippedPages: scannedPages.length - toRender.length,
    };
  } finally {
    await doc.loadingTask.destroy();
  }
}

/** Number of pages, for the preview. */
export async function pdfPageCount(pdf: Buffer): Promise<number> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  try {
    return doc.numPages;
  } finally {
    await doc.loadingTask.destroy();
  }
}

/** One page as a JPEG, for the preview. */
export async function renderPdfPage(pdf: Buffer, page: number): Promise<Buffer> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  try {
    const n = Math.min(Math.max(1, page), doc.numPages);
    const jpeg = await renderPageAsImage(doc, n, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale: 1.6,
      format: "jpeg",
      quality: 0.85,
    });
    return Buffer.from(jpeg);
  } finally {
    await doc.loadingTask.destroy();
  }
}
