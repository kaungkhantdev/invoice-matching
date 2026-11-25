import type { AddResult, DecisionStatus, InvoiceDetail, InvoiceSummary, Status } from "./types";

const NO_CONTENT = 204;

/** Every call the page makes to the NestJS API under /api. A failed call rejects with the server's message. */
export const api = {
  status: () => request<Status>("/status"),
  invoices: () => request<InvoiceSummary[]>("/invoices"),
  invoice: (id: string) => request<InvoiceDetail>(invoicePath(id)),
  /** One supplier invoice with its PO (screenshots of the PO page in our system). */
  uploadWithPo(po: File[], invoice: File) {
    const form = new FormData();
    for (const file of po) form.append("po", file, file.name);
    form.append("invoice", invoice, invoice.name);
    return request<AddResult>("/invoices/with-po", { method: "POST", body: form });
  },
  reread: (id: string) => post<InvoiceSummary>(`${invoicePath(id)}/reread`),
  decide: (id: string, decision: DecisionStatus, note: string, outcome: string | null) =>
    post<InvoiceSummary>(`${invoicePath(id)}/decision`, { decision, note, outcome }),
  recheck: () => post<InvoiceSummary[]>("/recheck"),
  clear: () => request<void>("/invoices", { method: "DELETE" }),
};

/** The original file (PDFs and photos open in the browser; other types download). */
export const fileUrl = (id: string) => `/api${invoicePath(id)}/file`;
/** A JPEG of a photo, HEIC or SVG, made by the server. */
export const imagePreviewUrl = (id: string, version: number) => `/api${invoicePath(id)}/preview?v=${version}`;
/** A JPEG of one PDF page, made by the server: works in every browser. */
export const pagePreviewUrl = (id: string, page: number) => `/api${invoicePath(id)}/preview?page=${page}`;
/** The same three for PO file n (1, 2, …) uploaded with the invoice. */
export const poFileUrl = (id: string, n: number) => `/api${invoicePath(id)}/po/${n}/file`;
export const poImagePreviewUrl = (id: string, n: number, version: number) =>
  `/api${invoicePath(id)}/po/${n}/preview?v=${version}`;
export const poPagePreviewUrl = (id: string, n: number, page: number) =>
  `/api${invoicePath(id)}/po/${n}/preview?page=${page}`;

/** The text to show for anything thrown. */
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Fetches /api + path. Throws an Error with the server's message, or when a success body isn't JSON (e.g. cut off). */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (response.status === NO_CONTENT) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // An error page that isn't JSON still gets the status line below.
    if (response.ok) throw new Error("The server sent a response that could not be read");
  }
  if (!response.ok) throw new Error(serverMessage(body) ?? `${response.status} ${response.statusText}`);
  return body as T;
}

/** POST, with `data` as a JSON body when given. */
function post<T>(path: string, data?: unknown) {
  if (data === undefined) return request<T>(path, { method: "POST" });
  const headers = { "content-type": "application/json" };
  return request<T>(path, { method: "POST", headers, body: JSON.stringify(data) });
}

function invoicePath(id: string) {
  return `/invoices/${encodeURIComponent(id)}`;
}

/** NestJS errors look like { statusCode, message, error }, where message may be a list. */
function serverMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("message" in body)) return null;
  const { message } = body;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map(String).join("; ");
  return null;
}
