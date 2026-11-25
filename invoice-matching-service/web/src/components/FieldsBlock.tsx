import { money, readByText } from "../format";
import type { InvoiceDetail, OnFile } from "../types";
import { Field, muted } from "./Field";

/** What was read from the invoice, next to what we have on file for the supplier. */
export function FieldsBlock({ detail }: { detail: InvoiceDetail }) {
  const invoice = detail.result?.invoice;
  const context = detail.result?.context ?? null;
  const review = detail.review;
  if (!invoice || !review) return null;

  const supplierNote = muted(context?.supplier ? " · on our list" : " · not on our list");
  const month = context?.month;
  const monthNote = month?.from && month.from !== "stated" && muted(` · from the ${month.from}`);
  // No PO number on the invoice: say so, unless one was found by site + month (then the note says which).
  const uploadedPo = context?.poFoundBy === "uploaded" ? context.po : null;
  const foundPo = context?.poFoundBy === "site and month" ? context.po : null;
  const poText = invoice.poNumber ?? (foundPo ? null : "none on the invoice");
  const poNote =
    (foundPo && muted(` · not on the invoice · found ${foundPo.poNumber} by site + month`)) ||
    (uploadedPo && muted(` · PO uploaded: ${uploadedPo.poNumber || "no number"}`));
  const dueNote = invoice.dueDate && muted(` · due ${invoice.dueDate}`);
  const included = invoice.pricesIncludeTax ? " (included)" : "";
  const totalNote = muted(` · subtotal ${invoice.subtotal} + GST ${invoice.tax}${included}`);
  const secondsNote = detail.seconds != null && muted(` · ${detail.seconds}s`);

  return (
    <section className="block">
      <p className="label">What was read</p>
      <dl className="fields">
        <Field label="Supplier" value={invoice.supplier.name} extra={supplierNote} />
        <Compared label="UEN" value={invoice.supplier.uen} file={review.onFile.uen} />
        <Compared label="GST reg. no." value={invoice.supplier.gstRegNo} file={review.onFile.gstRegNo} />
        <Compared label="Bank account" value={invoice.bank.accountNumber} file={review.onFile.bank} />
        <Field label="Billed to" value={invoice.billTo} />
        <Field label="Site" value={invoice.site} />
        <Field label="For month" value={month?.value ?? invoice.servicePeriod} extra={monthNote} />
        <Field label="PO" value={poText} extra={poNote} />
        <Field label="Service proof" value={review.serviceProof} />
        <Field label="Invoice date" value={invoice.invoiceDate} extra={dueNote} />
        <Field label="Total" value={money(invoice.currency, invoice.total)} extra={totalNote} />
        <Field label="Read by" value={readByText(detail.readBy, detail.model)} extra={secondsNote} />
      </dl>
    </section>
  );
}

/** A value read from the invoice, red when the API says it differs from what we have on file. */
function Compared({ label, value, file }: { label: string; value: string | null; file: OnFile }) {
  return (
    <Field
      label={label}
      value={<span className={file.differs ? "differs" : undefined}>{value ?? "–"}</span>}
      extra={file.onFile !== null && muted(` · on file ${file.onFile}`)}
    />
  );
}
