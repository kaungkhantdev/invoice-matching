import type { InvoiceDetail } from "../types";

/** The ring is drawn in a 40 × 40 box. */
const RING_CENTER = 20;
const RING_RADIUS = 17;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Two rings: checks passed, and invoice lines whose price and quantity match the PO (both counted by the API). */
export function MatchSummary({ detail }: { detail: InvoiceDetail }) {
  const review = detail.review;
  if (!review?.checks) return null;
  return (
    <section className="block">
      <p className="label">Match summary</p>
      <div className="rings">
        <Ring done={review.checksPassed} total={review.checks} label="Checks passed" />
        <Ring done={review.linesMatched} total={review.lines} label="Lines: price + qty match PO" />
      </div>
    </section>
  );
}

/** "3 of 7" next to a ring filled by that share. */
function Ring({ done, total, label }: { done: number; total: number; label: string }) {
  const share = total > 0 ? done / total : 0;
  return (
    <div className="ring-stat">
      <svg className="ring" viewBox="0 0 40 40" aria-hidden="true">
        <circle className="track" cx={RING_CENTER} cy={RING_CENTER} r={RING_RADIUS} />
        <circle
          className="value"
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          strokeDasharray={`${share * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
        />
      </svg>
      <div>
        <b>{total ? `${done} of ${total}` : "–"}</b>
        <span>{label}</span>
      </div>
    </div>
  );
}
