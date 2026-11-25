import { useState } from "react";
import { api, errorMessage } from "./api";
import type { DecisionStatus } from "./types";
import type { RefreshOptions } from "./useInvoices";
import type { ShowMessage } from "./useMessage";

/** The toolbar and list actions whose button is disabled while they run. */
type BusyAction = "recheck" | "clear";

type Refresh = (options?: RefreshOptions) => Promise<void>;

const BYTES_PER_MB = 2 ** 20;

/**
 * What the page can ask the API to do. Each action refreshes the list afterwards;
 * if it fails, the message line says why.
 * `maxBytes`: the largest file the API takes (from /api/status). `onDecided`: a decision was saved for this invoice.
 */
export function useActions({ maxBytes, showMessage, refresh, closePanel, onDecided }: {
  maxBytes: number;
  showMessage: ShowMessage;
  refresh: Refresh;
  closePanel: () => void;
  onDecided: (id: string) => void;
}) {
  const [busy, setBusy] = useState<Partial<Record<BusyAction, boolean>>>({});

  /** Runs an action; if it fails, the message line says why. */
  const run = (work: () => Promise<void>) => work().catch((error: unknown) => showMessage(errorMessage(error)));

  /** Runs an action with its button disabled, after clearing the message line. */
  async function withBusy(action: BusyAction, work: () => Promise<void>) {
    setBusy((current) => ({ ...current, [action]: true }));
    showMessage(null);
    await run(work);
    setBusy((current) => ({ ...current, [action]: false }));
  }

  /** One supplier invoice with its PO screenshots: kept and read together, then shown in the panel. */
  const uploadWithPo = (po: File[], invoice: File) =>
    void run(async () => {
      const tooBig = [...po, invoice].filter((file) => file.size > maxBytes).map((file) => file.name);
      if (tooBig.length) {
        showMessage(`Larger than ${Math.round(maxBytes / BYTES_PER_MB)} MB: ${tooBig.join(", ")}`);
        return;
      }
      showMessage("Uploading the PO and the invoice…", "info");
      await api.uploadWithPo(po, invoice);
      showMessage(null);
      await refresh({ selectNewest: true, resetAutoSelect: true });
    });

  const recheck = () =>
    withBusy("recheck", async () => {
      await api.recheck();
      await refresh({ reloadDetail: true });
      showMessage("Suppliers reloaded from data/, all checks run again.", "info");
    });

  function clear() {
    if (!window.confirm("Remove all invoices from this list? The uploaded copies are deleted too.")) return;
    void withBusy("clear", async () => {
      await api.clear();
      closePanel();
      await refresh();
    });
  }

  /** `seen`: the result on screen; the API refuses the decision if a re-check changed it meanwhile. */
  const decide = (id: string, decision: DecisionStatus, note: string, seen: string | null) =>
    run(async () => {
      await api.decide(id, decision, note, seen);
      await refresh();
      onDecided(id);
    });

  const reread = (id: string) =>
    run(async () => {
      await api.reread(id);
      await refresh();
    });

  return { busy, uploadWithPo, recheck, clear, decide, reread };
}
