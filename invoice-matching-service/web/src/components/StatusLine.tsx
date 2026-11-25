import type { Status } from "../types";

/** What reads the invoices (Amazon Bedrock + Textract), whether an AWS login is set up, and the queue. */
export function StatusLine({ status }: { status: Status | null }) {
  if (!status) return <div className="ai" />;
  const { ai, ocr, queue } = status;
  const ready = status.awsLogin === "found";
  const ocrRegion = ocr.region !== ai.region ? ` (${ocr.region})` : "";
  const queueBusy = queue.waiting || queue.reading;
  const queueText = queueBusy ? `queue: ${queue.reading} reading (max ${queue.limit}), ${queue.waiting} waiting` : null;
  const extra = [queueText, ready ? null : status.hint].filter(Boolean);

  return (
    <div className="ai">
      <span className={`dot ${ready ? "ok" : "bad"}`} aria-hidden="true" />
      <span className="sr-only">{ready ? "Ready:" : "Not ready:"}</span>
      <span>{`${ai.name} · ${ai.model} · ${ai.region} · OCR: ${ocr.name}${ocrRegion}`}</span>
      {extra.length > 0 && <span className="muted small">{extra.join(" · ")}</span>}
    </div>
  );
}
