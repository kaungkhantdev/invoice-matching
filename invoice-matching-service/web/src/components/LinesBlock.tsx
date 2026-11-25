import type { InvoiceDetail, LineComparison } from "../types";

/** Each invoice line against its PO line: a bar for the quantity, notes for price or quantity problems. */
export function LinesBlock({ detail }: { detail: InvoiceDetail }) {
  const context = detail.result?.context;
  if (!context?.po || !context.lines.length) return null;
  const how =
    context.poFoundBy === "site and month" ? " (found by site + month)" : context.poFoundBy === "uploaded" ? " (uploaded)" : "";
  return (
    <section className="block">
      <p className="label">{`Invoiced vs PO · ${context.po.poNumber || "no number"}${how}`}</p>
      {context.lines.map((line) => (
        <LineBar key={line.line} line={line} />
      ))}
    </section>
  );
}

/** One invoice line: a free extra, a line that isn't on the PO, or a bar of invoiced against the cap. */
function LineBar({ line }: { line: LineComparison }) {
  if (line.free) {
    return (
      <div className="bar-item">
        <BarHead description={line.description} value={line.quantity} />
        <div className="bar-note">0.00 · not on the PO (no charge)</div>
      </div>
    );
  }
  if (!line.po) {
    return (
      <div className="bar-item">
        <BarHead description={line.description} value={line.quantity} />
        <div className="bar over">
          <i style={{ width: "100%" }} />
        </div>
        <div className="bar-note bad">Not on the PO</div>
      </div>
    );
  }
  if (line.po.frequency) return <MonthlyLine line={line} />;
  // The API sets the cap (received for goods, ordered for services) and the notes; this only draws the bar.
  const cap = line.cap ?? line.quantity;
  const capWord = line.capFrom === "received" ? "received" : "on the PO";
  const barLabel = `${line.quantity} invoiced of ${cap} ${capWord}`;
  const over = line.qtyStatus === "fail";
  const priceTone = line.priceStatus === "fail" ? "bad" : "note";
  return (
    <div className="bar-item">
      <BarHead
        description={line.description}
        title={`PO: ${line.po.description}`}
        value={`${line.quantity} / ${cap}`}
      />
      <div className={`bar${over ? " over" : ""}`} role="img" aria-label={barLabel}>
        <i style={{ width: `${barPercent(line.quantity, cap)}%` }} />
      </div>
      {line.qtyNote && <div className="bar-note bad">{line.qtyNote}</div>}
      {line.priceNote && <div className={`bar-note ${priceTone}`}>{line.priceNote}</div>}
    </div>
  );
}

/**
 * A line of a recurring PO: the invoice's amount against the PO's monthly charge. (No bar: the PO counts visits,
 * the invoice counts items, so their quantities don't compare.)
 */
function MonthlyLine({ line }: { line: LineComparison }) {
  const po = line.po!;
  const perMonth = po.unitPrice ? `${po.orderedQty} × ${po.unitPrice} = ${po.amount}` : po.amount;
  const priceTone = line.priceStatus === "fail" ? "bad" : "note";
  return (
    <div className="bar-item">
      <BarHead description={line.description} title={`PO: ${po.description}`} value={line.invoiceAmountExTax} />
      <div className="bar-note">{`PO: ${po.description} · ${po.frequency} · ${perMonth} a month`}</div>
      {line.priceNote && <div className={`bar-note ${priceTone}`}>{line.priceNote}</div>}
    </div>
  );
}

/** The line's description, with its quantity on the right. */
function BarHead({ description, title, value }: { description: string; title?: string; value: string }) {
  return (
    <div className="bar-head">
      <span title={title}>{description}</span>
      <b>{value}</b>
    </div>
  );
}

/** How full the bar is: invoiced as a share of the cap, at most 100 (full when the cap is 0). */
function barPercent(quantity: string, cap: string) {
  const hasCap = Number(cap) > 0;
  if (!hasCap) return 100;
  return Math.min(100, Math.round((Number(quantity) / Number(cap)) * 100));
}
