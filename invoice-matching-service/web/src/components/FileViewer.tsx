import { useDialog } from "../useDialog";
import type { ViewedFile } from "../viewedFile";
import { IconButton } from "./Icon";

/** A file in a dialog (the invoice, or a PO file): the image, the PDF's pages (as images from the server), or the text. */
export function FileViewer({ file, onClose }: { file: ViewedFile; onClose: () => void }) {
  const { closeButton, backdrop } = useDialog(onClose);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Original file" {...backdrop}>
      <div className="modal-box">
        <div className="modal-head">
          <strong>{file.title}</strong>
          <div>
            <a className="link-btn" href={file.href} target="_blank" rel="noopener">
              Open in new tab
            </a>
            <IconButton ref={closeButton} icon="close" label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="modal-body">
          <Preview file={file} />
        </div>
      </div>
    </div>
  );
}

/** The file itself, in whichever form the server can show it. */
function Preview({ file }: { file: ViewedFile }) {
  switch (file.previewKind) {
    case "image":
      return <img src={file.imageSrc} alt={file.title} />;
    case "pages":
      return <Pages file={file} />;
    case "text":
      return <pre>{file.previewText ?? ""}</pre>;
    default:
      return <p className="panel-empty">No preview for this file type.</p>;
  }
}

/** The PDF's pages as images: at least one, even when the server could not count them. */
function Pages({ file }: { file: ViewedFile }) {
  const pageCount = Math.max(1, file.pages);
  return (
    <div className="pages">
      {Array.from({ length: pageCount }, (_, i) => (
        <img key={i} src={file.pageSrc(i + 1)} alt={`${file.title}, page ${i + 1}`} loading="lazy" />
      ))}
    </div>
  );
}
