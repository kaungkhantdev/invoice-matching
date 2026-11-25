import { Icon } from "./Icon";

/** The slim icon rail on the left. `inert`: a dialog is open over the page. */
export function Rail({ inert = false }: { inert?: boolean }) {
  return (
    <nav className="rail" aria-label="Main" inert={inert}>
      <span className="rail-logo" aria-hidden="true">
        <Icon name="logo" />
      </span>
      <a className="rail-item active" href="#" aria-current="page" title="Invoices">
        <Icon name="invoice" />
        <span className="sr-only">Invoices</span>
      </a>
    </nav>
  );
}
