import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Claims, InvoiceResult, PoReadResult, ReadResult } from "../../matching/matching.service.js";
import { SUPPORTED } from "../../matching/reader/file-prep.js";

/** Where an invoice is in the queue. */
export type EntryState = "QUEUED" | "READING" | "DONE";

/** A person's approval or rejection of one invoice. */
export interface Decision {
  status: "APPROVED" | "REJECTED";
  note: string;
  at: string;
  /** The result the person saw when deciding. If a re-check changes it, the decision is cleared. */
  outcome: string;
}

/** One invoice in the queue: its file, what was read, the check result and the decision. Saved as is in store.json. */
export interface Entry {
  id: string;
  /** Order the invoice arrived in. The later copy of a duplicate is the one flagged. */
  seq: number;
  file: string;
  ext: string;
  hash: string;
  size: number;
  addedAt: string;
  state: EntryState;
  /** Reading tries so far (temporary errors are retried up to READ_MAX_ATTEMPTS). */
  attempts: number;
  /** The last temporary error, while waiting to try again. */
  retryError: string | null;
  read: ReadResult | null;
  result: InvoiceResult | null;
  /** The PO uploaded with the invoice (screenshots of our system's PO page). Without it, the PO is looked up in data/. */
  po?: UploadedPoFiles;
  /** While it is read again: what the last result held (invoice key, PO), so later copies stay flagged meanwhile. */
  held?: Claims | null;
  decision: Decision | null;
  updatedAt: number;
}

/** The PO's files (kept as files/<id>-po1<ext>, …) and what Bedrock read from them (null until read). */
export interface UploadedPoFiles {
  files: { file: string; ext: string; size: number }[];
  read: PoReadResult | null;
}

/** A file to add: either already in memory, or a temporary file on disk (big uploads). */
export type IncomingFile = { name: string; data: Buffer } | { name: string; path: string };

/** File types the upload takes: everything the reader can read, plus InvoiceNow XML. */
export const ACCEPTED = new Set([...SUPPORTED, ".xml"]);
/** File types for the PO: screenshots of our system's PO page (or a PDF printout of it). */
export const PO_ACCEPTED = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif", ".pdf"]);
/** The most PO files with one invoice: a long PO page takes a few screenshots. */
export const MAX_PO_FILES = 5;
/** The biggest file taken (also the upload limit). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_NOTE_CHARS = 500;

/** Why a file can't be added (shown next to its name), or null when it can. `accepted`: the types allowed. */
export function skipReason(ext: string, size: number, accepted: Set<string> = ACCEPTED): string | null {
  if (!accepted.has(ext)) return "file type not supported";
  if (size > MAX_FILE_BYTES) return "larger than 25 MB";
  return null;
}

/** A just-added invoice: saved, waiting to be read. */
export function newEntry({ file, ext, size, seq, hash }: Pick<Entry, "file" | "ext" | "size" | "seq" | "hash">): Entry {
  return {
    id: randomUUID(),
    seq,
    file,
    ext,
    hash,
    size,
    addedAt: new Date().toISOString(),
    state: "QUEUED",
    attempts: 0,
    retryError: null,
    read: null,
    result: null,
    decision: null,
    updatedAt: Date.now(),
  };
}

/**
 * Forget the last read so the file (and its PO) are read again. `held`: what the last result held, so later copies
 * stay flagged.
 */
export function startOver(entry: Entry, held: Claims | null): void {
  if (entry.po) entry.po.read = null;
  Object.assign(entry, {
    attempts: 0,
    retryError: null,
    read: null,
    result: null,
    held,
    decision: null,
    updatedAt: Date.now(),
  });
}

/**
 * Record an approval or rejection. `seen`: the result the page showed. If a re-check changed it
 * meanwhile, the person must look again first.
 */
export function recordDecision(entry: Entry, status: Decision["status"], note: string, seen?: string): void {
  if (entry.state !== "DONE" || !entry.result) {
    throw new BadRequestException("This invoice hasn't been read yet");
  }
  const changedSinceSeen = Boolean(seen) && seen !== entry.result.outcome;
  if (changedSinceSeen) {
    throw new ConflictException(
      "This invoice was just checked again and its result changed. Look at it again, then decide.",
    );
  }
  entry.decision = {
    status,
    note: note.slice(0, MAX_NOTE_CHARS),
    at: new Date().toISOString(),
    outcome: entry.result.outcome,
  };
  entry.updatedAt = Date.now();
}
