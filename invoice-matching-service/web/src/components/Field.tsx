import type { ReactNode } from "react";

/** One row of a fields list (<dl className="fields">): the label, the value ("–" when missing), an optional grey note. */
export function Field({ label, value, extra }: { label: string; value: ReactNode; extra?: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value ?? "–"}
        {extra}
      </dd>
    </>
  );
}

/** A grey note after a value. */
export function muted(text: string) {
  return <span className="muted">{text}</span>;
}
