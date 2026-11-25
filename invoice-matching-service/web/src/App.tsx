import { useCallback, useRef, useState } from "react";
import { DetailPanel } from "./components/DetailPanel";
import { FileViewer } from "./components/FileViewer";
import { InvoiceTable } from "./components/InvoiceTable";
import { PoUpload } from "./components/PoUpload";
import { Rail } from "./components/Rail";
import { StatusLine } from "./components/StatusLine";
import { Summary } from "./components/Summary";
import { Toolbar } from "./components/Toolbar";
import { useActions } from "./useActions";
import { useInvoices } from "./useInvoices";
import { useMessage } from "./useMessage";
import { useStatus } from "./useStatus";
import type { ViewedFile } from "./viewedFile";

/** Up to this width (see styles/layout.css) the panel sits below the list, so picking an invoice scrolls to it. */
const PANEL_BELOW_LIST_PX = 1100;

/** The review page: the invoice list in the middle, the selected invoice in the panel on the right. */
export function App() {
  const [message, showMessage] = useMessage();
  const { invoices, loaded, selectedId, detail, refresh, select, close } = useInvoices(showMessage);
  const reading = invoices.some((invoice) => invoice.state !== "DONE");
  const status = useStatus(reading);
  const [search, setSearch] = useState("");
  /** Decision notes being typed, per invoice (kept when switching invoices). */
  const [notes, setNotes] = useState<Record<string, string>>({});
  const forgetNote = (id: string) =>
    setNotes((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  const actions = useActions({
    maxBytes: status?.upload.maxBytes ?? Infinity,
    showMessage,
    refresh,
    closePanel: close,
    onDecided: forgetNote,
  });
  const [viewer, setViewer] = useState<ViewedFile | null>(null);
  const closeViewer = useCallback(() => setViewer(null), []);
  const [poUploadOpen, setPoUploadOpen] = useState(false);
  const closePoUpload = useCallback(() => setPoUploadOpen(false), []);
  /** While a dialog is open, the page behind can't be reached (keyboard focus stays in the dialog). */
  const dialogOpen = viewer !== null || poUploadOpen;
  const panel = useRef<HTMLElement>(null);

  /** Opens an invoice in the panel; on narrow screens also scrolls down to it. */
  async function selectInvoice(id: string) {
    await select(id);
    const panelBelowList = window.innerWidth <= PANEL_BELOW_LIST_PX;
    if (panelBelowList) panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="app">
      <Rail inert={dialogOpen} />

      <main className="main" inert={dialogOpen}>
        <p className="eyebrow">{eyebrowText()}</p>
        <div className="title-row">
          <h1>Invoices</h1>
          <Toolbar
            search={search}
            onSearchChange={setSearch}
            recheckBusy={Boolean(actions.busy.recheck)}
            onRecheck={() => void actions.recheck()}
            onMatchWithPo={() => setPoUploadOpen(true)}
          />
        </div>

        <div className="subbar">
          <StatusLine status={status} />
          <Summary invoices={invoices} loaded={loaded} />
        </div>

        {message && (
          <p className={`message${message.kind === "info" ? " info" : ""}`} role="alert">
            {message.text}
          </p>
        )}

        <InvoiceTable
          invoices={invoices}
          search={search}
          selectedId={selectedId}
          onSelect={(id) => void selectInvoice(id)}
          onMatchWithPo={() => setPoUploadOpen(true)}
        />
        <button className="link-btn" type="button" disabled={actions.busy.clear} onClick={actions.clear}>
          Clear list
        </button>
      </main>

      <aside className="panel" aria-label="Invoice details" ref={panel} inert={dialogOpen}>
        {detail ? (
          <DetailPanel
            detail={detail}
            note={notes[detail.id] ?? detail.decision?.note ?? ""}
            onNoteChange={(note) => setNotes((current) => ({ ...current, [detail.id]: note }))}
            onDecide={(decision, note) => void actions.decide(detail.id, decision, note, detail.outcome)}
            onReread={() => void actions.reread(detail.id)}
            onView={setViewer}
            onClose={close}
          />
        ) : (
          <div className="panel-empty">Select an invoice to see how it matched.</div>
        )}
      </aside>

      {viewer && <FileViewer file={viewer} onClose={closeViewer} />}
      {poUploadOpen && (
        <PoUpload
          poAccept={status?.upload.poAccept ?? ""}
          invoiceAccept={status?.upload.accept ?? ""}
          maxPoFiles={status?.upload.maxPoFiles ?? 5}
          onMatch={actions.uploadWithPo}
          onClose={closePoUpload}
        />
      )}
    </div>
  );
}

/** The month above the title, e.g. "NOV'26". */
function eyebrowText(now = new Date()) {
  const month = now.toLocaleString("en", { month: "short" }).toUpperCase();
  const year = String(now.getFullYear()).slice(2);
  return `${month}'${year}`;
}
