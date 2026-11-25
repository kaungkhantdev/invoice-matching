import type { DecisionStatus, InvoiceSummary, Outcome, ReadBy } from "./types";

/** The colour of a status dot or tag (a CSS class). */
type Tone = "ok" | "note" | "bad" | "wait";

const OUTCOME: Record<Outcome, { label: string; cls: Tone }> = {
  MATCHED: { label: "Matched", cls: "ok" },
  MATCHED_WITH_NOTE: { label: "Matched, note", cls: "note" },
  REVIEW: { label: "Review", cls: "bad" },
};

/** Where an invoice is: in the queue, being read, or its result. */
export function statusOf(
  invoice: Pick<InvoiceSummary, "state" | "attempts" | "outcome">,
): { label: string; cls: Tone } {
  const retrying = invoice.state === "QUEUED" && invoice.attempts > 0;
  if (retrying) return { label: `Retrying (${invoice.attempts + 1})`, cls: "wait" };
  if (invoice.state === "QUEUED") return { label: "Waiting", cls: "wait" };
  if (invoice.state === "READING") return { label: "Reading…", cls: "wait" };
  return OUTCOME[invoice.outcome ?? "REVIEW"];
}

/** "Approved" or "Rejected". */
export const decisionLabel = (status: DecisionStatus) => (status === "APPROVED" ? "Approved" : "Rejected");

/** What read a file: the XML parser, Bedrock with its model, or (older results) just the model. */
export function readByText(readBy: ReadBy | null, model: string | null): string {
  if (readBy === "xml") return "InvoiceNow XML (no AI)";
  if (readBy === "bedrock") return `Amazon Bedrock${model ? ` · ${model}` : ""}`;
  // Results saved by earlier versions of the app (another AI) still show which model read them.
  return model ?? "–";
}

/** e.g. "SGD 1188.10", or "–" when there is no value. */
export const money = (currency: string | null | undefined, value: string | null | undefined) =>
  value == null ? "–" : `${currency ?? ""} ${value}`.trim();
