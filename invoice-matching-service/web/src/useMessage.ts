import { useCallback, useState } from "react";

/** Errors show red, info grey. */
export type MessageKind = "error" | "info";

/** Shows a line above the list (an error unless `kind` says "info"); null hides it. */
export type ShowMessage = (text: string | null, kind?: MessageKind) => void;

/** The one message line above the list, e.g. "Uploading 2 files…" or why an action failed. */
export function useMessage() {
  const [message, setMessage] = useState<{ text: string; kind: MessageKind } | null>(null);
  // Stable, so the hooks that report errors with it don't restart their polling on every render.
  const showMessage = useCallback<ShowMessage>(
    (text: string | null, kind: MessageKind = "error") => setMessage(text ? { text, kind } : null),
    [],
  );
  return [message, showMessage] as const;
}
