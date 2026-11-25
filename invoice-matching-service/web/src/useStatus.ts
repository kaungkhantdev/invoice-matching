import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Status } from "./types";

/** How often the status is fetched normally. */
const SLOW_MS = 15_000;
/** How often while invoices are being read, so the queue counts stay current. */
const BUSY_MS = 4_000;

/** GET /api/status, kept fresh (and fetched again when `reading` changes). Null until it first loads. */
export function useStatus(reading: boolean): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  const load = useCallback(() => {
    api.status().then(setStatus, () => {
      // Keep the last status: the list shows when the server can't be reached.
    });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, reading ? BUSY_MS : SLOW_MS);
    return () => clearInterval(timer);
  }, [reading, load]);

  return status;
}
