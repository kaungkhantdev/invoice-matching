import { decisionLabel, money, statusOf } from "../format";
import type { DecisionStatus, InvoiceDetail } from "../types";
import { invoiceFile, type ViewedFile } from "../viewedFile";
import { ChecksBlock } from "./ChecksBlock";
import { DecisionBlock } from "./DecisionBlock";
import { FieldsBlock } from "./FieldsBlock";
import { IconButton } from "./Icon";
import { LinesBlock } from "./LinesBlock";
import { MatchSummary } from "./MatchSummary";
import { PoBlock } from "./PoBlock";
import { RereadBlock } from "./RereadBlock";

interface Props {
  detail: InvoiceDetail;
  note: string;
  onNoteChange: (note: string) => void;
  onDecide: (decision: DecisionStatus, note: string) => void;
  onReread: () => void;
  /** Show a file: the invoice, or one of the PO files uploaded with it. */
  onView: (file: ViewedFile) => void;
  onClose: () => void;
}

/** One invoice: how it matched, what was read (and from its PO), and the decision. */
export function DetailPanel({ detail, note, onNoteChange, onDecide, onReread, onView, onClose }: Props) {
  const invoice = detail.result?.invoice ?? null;
  const status = statusOf(detail);
  const decision = detail.decision;
  const decisionTone = decision?.status === "APPROVED" ? "ok" : "bad";
  return (
    <div>
      <div className="panel-top">
        <IconButton icon="eye" label="View the invoice" onClick={() => onView(invoiceFile(detail))} />
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>
      <h2>{invoice?.supplier.name ?? detail.file}</h2>
      <p className="subtitle">{[invoice?.invoiceNumber, detail.file].filter(Boolean).join(" · ")}</p>
      <div className="result-line">
        <span className={`tag ${status.cls}`}>{status.label}</span>
        {decision && <span className={`tag ${decisionTone}`}>{decisionLabel(decision.status)}</span>}
        {invoice && <span className="muted">{money(invoice.currency, invoice.total)}</span>}
      </div>
      <MatchSummary detail={detail} />
      <LinesBlock detail={detail} />
      <ChecksBlock detail={detail} />
      <FieldsBlock detail={detail} />
      <PoBlock detail={detail} onView={onView} />
      <DecisionBlock detail={detail} note={note} onNoteChange={onNoteChange} onDecide={onDecide} />
      <RereadBlock detail={detail} onReread={onReread} />
    </div>
  );
}
