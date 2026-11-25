import { useRef, useState, type DragEvent } from "react";

/** Lets files be dropped on an element: spread `dropHandlers` on it. `dragging` is true while files are over it. */
export function useDropZone(onDrop: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave also fire for every child element, so count them to know when the files really left.
  const dragDepth = useRef(0);

  const dropHandlers = {
    onDragEnter(event: DragEvent) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => event.preventDefault(),
    onDragLeave() {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop(event: DragEvent) {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      onDrop([...event.dataTransfer.files]);
    },
  };

  return { dragging, dropHandlers };
}

/** Only dragged files show the drop overlay (not dragged text or links). */
function hasFiles(event: DragEvent) {
  return event.dataTransfer.types.includes("Files");
}
