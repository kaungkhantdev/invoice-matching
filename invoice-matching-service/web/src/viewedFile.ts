import { fileUrl, imagePreviewUrl, pagePreviewUrl, poFileUrl, poImagePreviewUrl, poPagePreviewUrl } from "./api";
import type { InvoiceDetail, PoFile, PreviewKind } from "./types";

/** A file the viewer dialog shows: the invoice, or one of the PO files uploaded with it. */
export interface ViewedFile {
  title: string;
  /** The file as uploaded (opens in a new tab). */
  href: string;
  previewKind: PreviewKind;
  previewText: string | null;
  pages: number;
  /** A JPEG of the picture. */
  imageSrc: string;
  /** A JPEG of one PDF page. */
  pageSrc: (page: number) => string;
}

/** The invoice file. */
export function invoiceFile(detail: InvoiceDetail): ViewedFile {
  return {
    title: detail.file,
    href: fileUrl(detail.id),
    previewKind: detail.previewKind,
    previewText: detail.previewText,
    pages: detail.pages,
    imageSrc: imagePreviewUrl(detail.id, detail.updatedAt),
    pageSrc: (page) => pagePreviewUrl(detail.id, page),
  };
}

/** One PO file uploaded with the invoice. */
export function poFile(detail: InvoiceDetail, file: PoFile): ViewedFile {
  return {
    title: `PO: ${file.file}`,
    href: poFileUrl(detail.id, file.n),
    previewKind: file.previewKind,
    previewText: file.previewText,
    pages: file.pages,
    imageSrc: poImagePreviewUrl(detail.id, file.n, detail.updatedAt),
    pageSrc: (page) => poPagePreviewUrl(detail.id, file.n, page),
  };
}
