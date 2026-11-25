import { useMemo, type KeyboardEvent } from "react";
import { decisionLabel, statusOf } from "../format";
import type { InvoiceSummary } from "../types";

interface Props {
  invoices: InvoiceSummary[];
  search: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Opens the dialog for an invoice with its PO: the only way to add one. */
  onMatchWithPo: () => void;
}

/** The invoice list, newest first, filtered by the search. */
export function InvoiceTable({ invoices, search, selectedId, onSelect, onMatchWithPo }: Props) {
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...invoices].sort((a, b) => b.seq - a.seq).filter((invoice) => !query || matchesSearch(invoice, query));
  }, [invoices, search]);

  return (
    <div className="table" role="table" aria-label="Invoices">
      <div className="thead" role="row">
        <span role="columnheader">Supplier</span>
        <span role="columnheader">Invoice</span>
        <span role="columnheader" className="hide-sm">
          PO
        </span>
        <span role="columnheader" className="num">
          Total
        </span>
        <span role="columnheader">Result</span>
      </div>
      <div className="rows">
        {rows.map((invoice) => (
          <InvoiceRow key={invoice.id} invoice={invoice} selected={invoice.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
      {invoices.length === 0 && (
        <div className="empty">
          <strong>No invoices yet</strong>
          <span>Add a supplier invoice together with screenshots of its PO.</span>
          <button className="btn primary" type="button" onClick={onMatchWithPo}>
            Match an invoice with its PO
          </button>
        </div>
      )}
    </div>
  );
}

/** The search looks in the supplier, invoice number, PO number and file name. */
function matchesSearch(invoice: InvoiceSummary, query: string) {
  const searched = [invoice.supplier, invoice.invoiceNumber, invoice.poNumber, invoice.file];
  return searched.some((value) => value?.toLowerCase().includes(query));
}

interface RowProps {
  invoice: InvoiceSummary;
  selected: boolean;
  onSelect: (id: string) => void;
}

/** One invoice; a click, Enter or Space opens it in the panel. */
function InvoiceRow({ invoice, selected, onSelect }: RowProps) {
  const status = statusOf(invoice);
  const open = () => onSelect(invoice.id);
  const openOnKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  };
  return (
    <div
      className={`row${selected ? " selected" : ""}`}
      role="row"
      tabIndex={0}
      aria-selected={selected}
      onClick={open}
      onKeyDown={openOnKey}
    >
      <span className={`cell strong${invoice.supplier ? "" : " muted"}`} role="cell" title={invoice.file}>
        {invoice.supplier ?? invoice.file}
      </span>
      <span className="cell" role="cell">
        {invoice.invoiceNumber ?? "–"}
      </span>
      <span className="cell hide-sm" role="cell">
        {invoice.poNumber ?? "–"}
        {invoice.poFoundBy === "site and month" && (
          <span className="muted small" title="Not on the invoice: found by supplier, site and month">
            {" · by site + month"}
          </span>
        )}
        {invoice.poFoundBy === "uploaded" && (
          <span className="muted small" title="Read from the PO screenshots uploaded with the invoice">
            {" · uploaded"}
          </span>
        )}
      </span>
      <span className="cell num" role="cell">
        {invoice.total ?? "–"}
      </span>
      <span className="cell" role="cell">
        <span className={`status ${status.cls}`}>
          <span className="status-dot" aria-hidden="true" />
          {status.label}
        </span>
        {invoice.decision && <span className="decided">{` · ${decisionLabel(invoice.decision.status)}`}</span>}
      </span>
    </div>
  );
}
