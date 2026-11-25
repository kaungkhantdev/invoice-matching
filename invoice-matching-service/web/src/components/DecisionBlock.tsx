import { decisionLabel } from "../format";
import type { Decision, DecisionStatus, InvoiceDetail } from "../types";

interface Props {
  detail: InvoiceDetail;
  note: string;
  onNoteChange: (note: string) => void;
  onDecide: (decision: DecisionStatus, note: string) => void;
}

/** Approve or reject, with a note. Approving a Review invoice asks first. */
export function DecisionBlock({ detail, note, onNoteChange, onDecide }: Props) {
  if (detail.state !== "DONE") return null;

  function decide(decision: DecisionStatus) {
    const approvingFailedInvoice = decision === "APPROVED" && detail.outcome === "REVIEW";
    if (approvingFailedInvoice && !window.confirm("This invoice failed checks. Approve it anyway?")) return;
    onDecide(decision, note);
  }

  return (
    <section className="block">
      <p className="label">Decision</p>
      {detail.decision && <p className="muted small">{decisionText(detail.decision)}</p>}
      <div className="actions">
        <input
          type="text"
          placeholder="Note, e.g. confirmed new bank account by phone"
          aria-label="Decision note"
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
        />
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => decide("APPROVED")}>
            Approve
          </button>
          <button type="button" className="btn" onClick={() => decide("REJECTED")}>
            Reject
          </button>
        </div>
      </div>
    </section>
  );
}

/** The decision already taken, e.g. "Approved 24/11/2026, 10:30:00 · confirmed new bank account by phone". */
function decisionText(decision: Decision) {
  const note = decision.note ? ` · ${decision.note}` : "";
  return `${decisionLabel(decision.status)} ${new Date(decision.at).toLocaleString()}${note}`;
}
