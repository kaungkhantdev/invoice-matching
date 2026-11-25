import {
  emptySeen,
  type InvoiceResult,
  type MatchingService,
  type PoReadResult,
  type Seen,
} from "../../matching/matching.service.js";
import type { Entry } from "./entry.js";

/**
 * Run the checks again for the invoices from `fromSeq` on, in arrival order, and keep any new results.
 * Earlier invoices are unchanged, so they're only remembered for the duplicate check.
 */
export async function recheckEntries(entries: Entry[], matching: MatchingService, fromSeq: number): Promise<void> {
  const seen = emptySeen();
  for (const entry of entries) {
    if (entry.state !== "DONE" || !entry.read) {
      rememberUnread(matching, seen, entry);
      continue;
    }
    if (entry.seq < fromSeq && entry.result) {
      matching.remember(seen, entry.file, entry.hash, entry.result);
      continue;
    }
    const approved = entry.decision?.status === "APPROVED";
    const result = await matching.check(entry.file, entry.hash, entry.read, seen, approved, uploadedPoRead(entry));
    matching.remember(seen, entry.file, entry.hash, result);
    keepResult(entry, result);
  }
}

/** The PO uploaded with the invoice, as read. One not read counts as unreadable, never as "look it up in data/". */
function uploadedPoRead(entry: Entry): PoReadResult | undefined {
  if (!entry.po) return undefined;
  return entry.po.read ?? { po: null, model: null, error: "the PO hasn't been read", retryable: false, seconds: 0 };
}

/**
 * Not read yet, but its file fingerprint is known: a later identical file is a duplicate right away.
 * Being read again: it still holds its invoice and PO until the new result is in.
 */
function rememberUnread(matching: MatchingService, seen: Seen, entry: Entry): void {
  if (entry.held) matching.remember(seen, entry.file, entry.hash, entry.held);
  else if (!seen.byHash.has(entry.hash)) seen.byHash.set(entry.hash, entry.file);
}

/** Store a result that differs from the last one. A decision made on the old result no longer applies. */
function keepResult(entry: Entry, result: InvoiceResult): void {
  if (JSON.stringify(result) === JSON.stringify(entry.result)) return;
  entry.result = result;
  entry.updatedAt = Date.now();
  if (entry.decision && entry.decision.outcome !== result.outcome) entry.decision = null;
}
