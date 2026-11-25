import type { InvoiceDetail } from "../types";

/** Read the file again with Textract + Bedrock, and its PO if one was uploaded (not InvoiceNow XML alone: no AI). */
export function RereadBlock({ detail, onReread }: { detail: InvoiceDetail; onReread: () => void }) {
  if (detail.readBy === "xml" && !detail.withPo) return null;
  return (
    <section className="block">
      <p className="label">{detail.withPo ? "Read the invoice and its PO again" : "Read again"}</p>
      <div className="reread">
        <button type="button" className="btn" onClick={onReread} disabled={detail.state !== "DONE"}>
          Read again
        </button>
      </div>
    </section>
  );
}
