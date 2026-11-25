import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import type { InvoiceDetail, InvoiceSummary } from "./types";

/** How often the list is fetched while the page is visible (or invoices are still being read). */
const POLL_MS = 2000;

const NO_INVOICES: InvoiceSummary[] = [];

/** What a refresh should do besides fetching the list. */
export interface RefreshOptions {
  /** Select the newest invoice afterwards (e.g. after an upload that added files). */
  selectNewest?: boolean;
  /** Pick the newest invoice again if none is selected (e.g. after any upload). */
  resetAutoSelect?: boolean;
  /** Load the selected invoice again even if it looks unchanged (e.g. after a re-check). */
  reloadDetail?: boolean;
}

/**
 * The invoice list, the selected invoice and its detail, kept fresh by polling.
 * The newest invoice is selected on first load; a changed invoice (updatedAt) reloads its detail.
 * Refreshes run one at a time, a poll is skipped while one runs, and each invoice's detail is fetched once at a time.
 */
export function useInvoices(onError: (text: string | null) => void) {
  /** null until the list has loaded once. */
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  // What async work and timers need to read now, not as of the render they started in.
  const liveRef = useRef({
    invoices: NO_INVOICES,
    /** The last list as JSON, to tell whether a poll changed anything. */
    listText: "",
    selectedId: null as string | null,
    /** updatedAt of the detail on screen; null makes the next refresh load it again. */
    detailStamp: null as number | null,
    /** The newest invoice was already picked once, so the page doesn't keep reselecting it. */
    autoSelected: false,
    /** The last refresh in line; the next one starts after it. */
    queue: Promise.resolve(),
    /** Refreshes running or waiting. */
    refreshes: 0,
    /** The last refresh couldn't reach the server (its message is showing). */
    unreachable: false,
    /** Detail requests in flight, by invoice id. */
    loading: new Map<string, Promise<void>>(),
  });

  /** Fetches one invoice's detail, sharing a request for it that is already in flight. */
  const loadDetail = useCallback(
    (id: string) => {
      const live = liveRef.current;
      const inFlight = live.loading.get(id);
      if (inFlight) return inFlight;
      const load = api
        .invoice(id)
        .then(
          (loaded) => {
            if (id !== live.selectedId) return; // another invoice was picked meanwhile
            live.detailStamp = loaded.updatedAt;
            setDetail(loaded);
          },
          (error: unknown) => onError(errorMessage(error)),
        )
        .finally(() => live.loading.delete(id));
      live.loading.set(id, load);
      return load;
    },
    [onError],
  );

  /** Shows an invoice in the panel. */
  const select = useCallback(
    async (id: string) => {
      liveRef.current.selectedId = id;
      liveRef.current.detailStamp = null;
      setSelectedId(id);
      await loadDetail(id);
    },
    [loadDetail],
  );

  /** Empties the panel. */
  const close = useCallback(() => {
    liveRef.current.selectedId = null;
    liveRef.current.detailStamp = null;
    setSelectedId(null);
    setDetail(null);
  }, []);

  /** Puts a new list on screen, only when something changed, so the list doesn't re-render every poll. */
  const showList = useCallback((list: InvoiceSummary[]) => {
    const live = liveRef.current;
    const text = JSON.stringify(list);
    if (text === live.listText) return;
    live.listText = text;
    live.invoices = list;
    setInvoices(list);
  }, []);

  /** Nothing picked yet: select the newest invoice (once). Else close the selected one if gone, reload if changed. */
  const followSelection = useCallback(
    async (list: InvoiceSummary[]) => {
      const live = liveRef.current;
      const pickNewest = !live.selectedId && !live.autoSelected && list.length > 0;
      if (pickNewest) {
        live.autoSelected = true;
        const newest = list.reduce((a, b) => (b.seq > a.seq ? b : a));
        await select(newest.id);
        return;
      }
      const selected = list.find((invoice) => invoice.id === live.selectedId);
      if (live.selectedId && !selected) close();
      else if (selected && selected.updatedAt !== live.detailStamp) await loadDetail(selected.id);
    },
    [select, close, loadDetail],
  );

  /** One refresh: the list, then the panel. Called through `refresh`, which runs them one at a time. */
  const refreshNow = useCallback(
    async ({ selectNewest = false, resetAutoSelect = false, reloadDetail = false }: RefreshOptions) => {
      const live = liveRef.current;
      if (selectNewest) live.selectedId = null;
      if (selectNewest || resetAutoSelect) live.autoSelected = false;
      if (reloadDetail) live.detailStamp = null;

      let list: InvoiceSummary[];
      try {
        list = await api.invoices();
      } catch (error) {
        live.unreachable = true;
        onError(`Can't reach the server: ${errorMessage(error)}`);
        return;
      }
      if (live.unreachable) {
        live.unreachable = false;
        onError(null); // the server is back: drop the "can't reach" message
      }
      showList(list);
      await followSelection(list);
    },
    [onError, showList, followSelection],
  );

  /** Fetch the list (and the selected detail if it changed), after any refresh still running. */
  const refresh = useCallback(
    (options: RefreshOptions = {}) => {
      const live = liveRef.current;
      live.refreshes++;
      const thisRefresh = live.queue.then(() => refreshNow(options)).finally(() => live.refreshes--);
      live.queue = thisRefresh.catch(() => {});
      return thisRefresh;
    },
    [refreshNow],
  );

  // Load now, then poll.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      const live = liveRef.current;
      if (live.refreshes) return; // the last one is still waiting for the server
      const stillReading = live.invoices.some((invoice) => invoice.state !== "DONE");
      if (document.visibilityState === "visible" || stillReading) void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return {
    invoices: invoices ?? NO_INVOICES,
    loaded: invoices !== null,
    selectedId,
    detail,
    refresh,
    select,
    close,
  };
}
