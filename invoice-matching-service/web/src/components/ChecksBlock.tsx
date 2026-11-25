import type { CheckResult, CheckStatus, InvoiceDetail } from "../types";

const MARK: Record<CheckStatus, string> = { pass: "✓", note: "!", fail: "✗", skip: "–" };

/** The 7 checks with their findings, or where the invoice is in the queue. */
export function ChecksBlock({ detail }: { detail: InvoiceDetail }) {
  if (detail.state !== "DONE") {
    return (
      <section className="block">
        <p className="label">Checks</p>
        <p className="muted">{waitText(detail)}</p>
      </section>
    );
  }
  const checks = detail.result?.checks ?? [];
  // A read failure, or else the checks themselves failing (e.g. a broken data/ file on a re-check).
  const error = detail.error ? `Could not read the file: ${detail.error}` : (detail.result?.error ?? null);
  return (
    <section className="block">
      <p className="label">Checks</p>
      {error && <div className="error-box">{error}</div>}
      {checks.length > 0 && (
        <ul className="checks">
          {checks.map((check) => (
            <CheckItem key={check.id} check={check} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One check: its mark, its name and what it found. */
function CheckItem({ check }: { check: CheckResult }) {
  return (
    <li>
      <span className={`mark ${check.status}`} aria-label={check.status}>
        {MARK[check.status]}
      </span>
      <div>
        <span>{check.name}</span>
        <CheckDetails check={check} />
      </div>
    </li>
  );
}

/** One line per finding; with none, "OK" for a pass and an empty line otherwise. */
function CheckDetails({ check }: { check: CheckResult }) {
  if (!check.details.length) return <span className="check-detail">{check.status === "pass" ? "OK" : ""}</span>;
  return check.details.map((text, i) => (
    <span key={i} className={`check-detail ${check.status}`}>
      {text}
    </span>
  ));
}

/** Why there are no checks yet. */
function waitText(detail: InvoiceDetail) {
  if (detail.state === "READING") return "Reading the invoice…";
  if (detail.retryError) return `Will try again: ${detail.retryError}`;
  return "Waiting in the queue…";
}
