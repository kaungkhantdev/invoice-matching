import { readByText } from "../format";
import type { InvoiceDetail } from "../types";
import { poFile, type ViewedFile } from "../viewedFile";
import { Field, muted } from "./Field";
import { Icon } from "./Icon";

/** The PO uploaded with the invoice: what was read from its screenshots, and the screenshots themselves. */
export function PoBlock({ detail, onView }: { detail: InvoiceDetail; onView: (file: ViewedFile) => void }) {
  const uploaded = detail.po;
  if (!uploaded) return null;
  // What the checks compared with (null until checked, or when the PO couldn't be read).
  const po = detail.result?.context?.poFoundBy === "uploaded" ? detail.result.context.po : null;
  const contract = po?.validFrom || po?.validTo ? `${po.validFrom ?? "?"} to ${po.validTo ?? "?"}` : null;
  const secondsNote = uploaded.seconds != null && muted(` · ${uploaded.seconds}s`);
  return (
    <section className="block">
      <p className="label">PO uploaded</p>
      {uploaded.error && <p className="bar-note bad">{`Couldn't read the PO: ${uploaded.error}`}</p>}
      {po && (
        <dl className="fields">
          <Field label="PO" value={po.poNumber || null} extra={po.status && muted(` · ${po.status}`)} />
          <Field label="Supplier" value={po.supplierName} />
          <Field label="Site" value={po.site} />
          <Field label="Contract" value={contract} />
          <Field label="Items" value={String(po.lines.length)} />
          <Field label="Read by" value={readByText("bedrock", uploaded.model)} extra={secondsNote} />
        </dl>
      )}
      <div className="po-files">
        {uploaded.files.map((file) => (
          <button key={file.n} type="button" className="file-chip" onClick={() => onView(poFile(detail, file))}>
            <Icon name="eye" />
            <span>{file.file}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
