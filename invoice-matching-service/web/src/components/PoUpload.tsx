import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useDialog } from "../useDialog";
import { useDropZone } from "../useDropZone";
import { IconButton } from "./Icon";

interface Props {
  /** File types the API takes for the PO, and for the invoice (from /api/status). */
  poAccept: string;
  invoiceAccept: string;
  maxPoFiles: number;
  onMatch: (po: File[], invoice: File) => void;
  onClose: () => void;
}

/** Match one supplier invoice with its PO: 1. the PO page's screenshots, 2. the supplier's invoice, then Match. */
export function PoUpload({ poAccept, invoiceAccept, maxPoFiles, onMatch, onClose }: Props) {
  const { closeButton, backdrop } = useDialog(onClose);
  const [po, setPo] = useState<File[]>([]);
  const [invoice, setInvoice] = useState<File | null>(null);
  const tooMany = po.length > maxPoFiles;
  const ready = po.length > 0 && !tooMany && invoice !== null;

  const match = () => {
    if (!ready) return;
    onMatch(po, invoice);
    onClose();
  };

  return (
    // A file dropped next to the boxes must not make the browser leave the page to open it.
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Match an invoice with its PO"
      {...backdrop}
      onDragOver={stopBrowserOpening}
      onDrop={stopBrowserOpening}
    >
      <div className="modal-box narrow">
        <div className="modal-head">
          <strong>Match an invoice with its PO</strong>
          <IconButton ref={closeButton} icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="po-upload">
          <DropBox
            step="1"
            title="PO details"
            hint={`Screenshots of the PO page in our system (up to ${maxPoFiles}; overlapping is fine), or a PDF of it`}
            accept={poAccept}
            multiple
            files={po}
            onAdd={(files) => setPo((current) => [...current, ...files])}
            onRemove={(i) => setPo((current) => current.filter((_, j) => j !== i))}
          />
          <DropBox
            step="2"
            title="Supplier invoice"
            hint="The supplier's invoice: PDF, photo, Excel…"
            accept={invoiceAccept}
            files={invoice ? [invoice] : []}
            onAdd={(files) => setInvoice(files[0] ?? null)}
            onRemove={() => setInvoice(null)}
          />
          {tooMany && <p className="bar-note bad">{`At most ${maxPoFiles} PO files: remove ${po.length - maxPoFiles}`}</p>}
          <div className="po-upload-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={!ready} onClick={match}>
              Match
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface DropBoxProps {
  step: string;
  title: string;
  hint: string;
  accept: string;
  /** Several files (the PO's screenshots), or one (the invoice: a new one replaces it). */
  multiple?: boolean;
  files: File[];
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
}

/** One numbered box: drop files on it, or choose them. */
function DropBox({ step, title, hint, accept, multiple = false, files, onAdd, onRemove }: DropBoxProps) {
  const input = useRef<HTMLInputElement>(null);
  const { dragging, dropHandlers } = useDropZone(onAdd);
  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = ""; // so choosing the same file again still adds it
    onAdd(chosen);
  };
  return (
    <div className={`drop-box${dragging ? " dragging" : ""}`} {...dropHandlers}>
      <p className="drop-title">
        <span className="step">{step}</span>
        {title}
      </p>
      <p className="muted small">{hint}</p>
      {files.length > 0 && (
        <ul className="picked">
          {files.map((file, i) => (
            <li key={`${file.name}-${i}`}>
              <span>{file.name}</span>
              <button type="button" className="link-btn" onClick={() => onRemove(i)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn" onClick={() => input.current?.click()}>
        {multiple ? "Drop or choose files" : files.length ? "Choose another file" : "Drop or choose a file"}
      </button>
      <input ref={input} type="file" hidden accept={accept} multiple={multiple} onChange={picked} />
    </div>
  );
}

function stopBrowserOpening(event: DragEvent) {
  event.preventDefault();
}
