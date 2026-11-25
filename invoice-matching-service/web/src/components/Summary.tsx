import type { InvoiceSummary, Outcome } from "../types";

/** Counts above the list: how many matched, need review, are still being read. Empty until the list has loaded. */
export function Summary({ invoices, loaded }: { invoices: InvoiceSummary[]; loaded: boolean }) {
  if (!loaded) return <div className="summary" aria-label="Summary" />;
  const count = (matches: (invoice: InvoiceSummary) => boolean) => invoices.filter(matches).length;
  const withOutcome = (outcome: Outcome) => count((invoice) => invoice.outcome === outcome);
  const reading = count((invoice) => invoice.state !== "DONE");
  const decided = count((invoice) => invoice.decision !== null);
  const items: [number, string][] = [
    [invoices.length, "invoices"],
    [withOutcome("MATCHED"), "matched"],
    [withOutcome("MATCHED_WITH_NOTE"), "with note"],
    [count((invoice) => invoice.needsReview), "to review"],
  ];
  if (reading) items.push([reading, "waiting or reading"]);
  if (decided) items.push([decided, "decided"]);
  return (
    <div className="summary" aria-label="Summary">
      {items.map(([howMany, label]) => (
        <span key={label}>
          <b>{howMany}</b>
          {` ${label}`}
        </span>
      ))}
    </div>
  );
}
