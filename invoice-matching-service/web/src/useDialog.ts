import { useEffect, useRef, type MouseEvent } from "react";

/**
 * What every dialog does: focus starts on its Close button, Escape closes it, a click on the dark backdrop closes
 * it, and afterwards focus goes back to where it was. Put `closeButton` on Close and spread `backdrop` on the
 * backdrop. (App.tsx makes the page behind inert while a dialog is open, so focus stays in the dialog.)
 */
export function useDialog(onClose: () => void) {
  const closeButton = useRef<HTMLButtonElement>(null);
  /** The press started on the backdrop: selecting text in the box and letting go outside it must not close it. */
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      returnFocus?.focus();
    };
  }, [onClose]);

  const backdrop = {
    onMouseDown: (event: MouseEvent) => {
      pressedOnBackdrop.current = event.target === event.currentTarget;
    },
    /** Only a click both pressed and released on the backdrop itself, not inside the box. */
    onClick: (event: MouseEvent) => {
      if (pressedOnBackdrop.current && event.target === event.currentTarget) onClose();
      pressedOnBackdrop.current = false;
    },
  };

  return { closeButton, backdrop };
}
