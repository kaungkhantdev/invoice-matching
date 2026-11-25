import { mkdir, readFile, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { BadRequestException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { config } from "../config.js";
import { AccountingSource } from "../matching/accounting/accounting.source.js";
import { MatchingService } from "../matching/matching.service.js";
import { MAX_PO_FILES, newEntry, PO_ACCEPTED, recordDecision, skipReason, startOver } from "./store/entry.js";
import type { Decision, Entry, IncomingFile } from "./store/entry.js";
import { discardUpload, keepFile, loadEntries, writeAtomically } from "./store/files.js";
import { recheckEntries } from "./store/recheck.js";

// Re-exported so existing imports keep working.
export { ACCEPTED, MAX_FILE_BYTES, MAX_PO_FILES, PO_ACCEPTED } from "./store/entry.js";
export type { Decision, Entry, EntryState, IncomingFile } from "./store/entry.js";

/** Wait before trying again after a temporary error: 30 s, then 60 s, … */
const RETRY_DELAY_MS = 30_000;
const SAVE_DELAY_MS = 500;

/**
 * The invoice queue behind the web UI: files, what was read, check results and decisions.
 *
 * Any number of invoices can arrive at once (e.g. 700 at month end). They are saved and queued
 * immediately; Textract + Bedrock read at most BEDROCK_CONCURRENCY at a time; temporary errors
 * are retried with a pause. Kept in UI_STORE_DIR (default output/ui) so a restart picks up where
 * it left off. In the full system this becomes a database table (see ../docs/INFRASTRUCTURE-AWS.md).
 */
@Injectable()
export class InvoiceStore implements OnModuleInit {
  private readonly dir = resolve(config.uiStoreDir);
  private readonly filesDir = join(this.dir, "files");
  private readonly storeFile = join(this.dir, "store.json");
  private entries: Entry[] = [];
  private nextSeq = 1;
  /** Waiting for one of the BEDROCK_CONCURRENCY reading slots. */
  private waiting: Entry[] = [];
  private running = 0;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();
  private rechecking: Promise<void> = Promise.resolve();

  constructor(
    private readonly matching: MatchingService,
    private readonly accounting: AccountingSource,
  ) {}

  /** Pick up where the last run left off. */
  async onModuleInit(): Promise<void> {
    await mkdir(this.filesDir, { recursive: true });
    const saved = await loadEntries(this.storeFile);
    if (!saved) return;
    this.entries = saved;
    this.nextSeq = Math.max(0, ...saved.map((entry) => entry.seq)) + 1;
    // Anything that was waiting or being read when the server stopped goes back in the queue.
    for (const entry of this.list()) {
      if (entry.state !== "DONE") this.enqueue(entry);
    }
    // Saved results are checked again with today's rules and data (no AI; about a second for 700).
    await this.recheck(0, true).catch(() => undefined);
  }

  /** Every invoice, in the order they arrived. */
  list(): Entry[] {
    return [...this.entries].sort((a, b) => a.seq - b.seq);
  }

  get(id: string): Entry {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new NotFoundException(`No invoice with id ${id}`);
    return entry;
  }

  /** Where the original file is kept. */
  filePath(entry: Entry): string {
    return join(this.filesDir, `${entry.id}${entry.ext}`);
  }

  /** Where the PO files uploaded with the invoice are kept, in the order they were uploaded. */
  poFilePaths(entry: Entry): string[] {
    return (entry.po?.files ?? []).map((file, i) => join(this.filesDir, `${entry.id}-po${i + 1}${file.ext}`));
  }

  /** PO file `n` (1, 2, …) uploaded with the invoice: its name, type and where it is kept. */
  poFile(entry: Entry, n: string): { file: string; ext: string; path: string } {
    const i = Number(n) - 1;
    const file = Number.isInteger(i) ? entry.po?.files[i] : undefined;
    if (!file) throw new NotFoundException(`No PO file ${n} with this invoice`);
    return { file: file.file, ext: file.ext, path: this.poFilePaths(entry)[i] };
  }

  /** How many are waiting / being read (for the status line). */
  queueStats() {
    return { waiting: this.waiting.length, reading: this.running, limit: config.bedrock.concurrency };
  }

  /**
   * Add one supplier invoice with its PO: screenshots (or a printout) of the PO page in our system. This is the only
   * way in. They are kept and queued together: the PO is read first, then the invoice is read and checked against it.
   * All or nothing: if a file is refused, none is kept.
   */
  async addWithPo(poFiles: IncomingFile[], invoiceFiles: IncomingFile[]): Promise<Entry> {
    const uploads = [...poFiles, ...invoiceFiles];
    let po: { incoming: IncomingFile; ext: string; data: Buffer }[];
    let invoice: { incoming: IncomingFile; ext: string; data: Buffer };
    try {
      if (poFiles.length < 1 || poFiles.length > MAX_PO_FILES || invoiceFiles.length !== 1) {
        throw new BadRequestException(`Add the PO (1 to ${MAX_PO_FILES} screenshots) and one supplier invoice`);
      }
      po = await Promise.all(poFiles.map((file) => accepted(file, "PO", PO_ACCEPTED)));
      invoice = await accepted(invoiceFiles[0], "Invoice");
    } catch (error) {
      await Promise.all(uploads.map(discardUpload));
      throw error;
    }
    const entry = newEntry({
      file: invoice.incoming.name,
      ext: invoice.ext,
      size: invoice.data.length,
      seq: this.nextSeq++,
      hash: this.matching.fingerprint(invoice.data),
    });
    entry.po = { files: po.map(({ incoming, ext, data }) => ({ file: incoming.name, ext, size: data.length })), read: null };
    await keepFile(invoice.incoming, invoice.data, this.filePath(entry));
    const poPaths = this.poFilePaths(entry);
    await Promise.all(po.map(({ incoming, data }, i) => keepFile(incoming, data, poPaths[i])));
    this.entries.push(entry);
    // Save first, read later: the list is on disk before any AI touches these files.
    await this.saveNow();
    this.enqueue(entry);
    return entry;
  }

  /** Read the file again. (While the app runs, Textract's pages are reused, not paid for again.) */
  reread(id: string): Entry {
    const entry = this.get(id);
    if (entry.state !== "DONE") return entry;
    startOver(entry, entry.result ? this.matching.claims(entry.result) : null);
    this.enqueue(entry);
    void this.recheck(entry.seq, false);
    return entry;
  }

  /** Approve or reject. `seen`: the result the page showed; refused if a re-check changed it since. */
  decide(id: string, status: Decision["status"], note: string, seen?: string): Entry {
    const entry = this.get(id);
    recordDecision(entry, status, note, seen);
    this.saveSoon();
    return entry;
  }

  /** Reload suppliers and POs from data/ and run every check again (no AI). */
  recheckAll(): Promise<void> {
    return this.recheck(0, true);
  }

  /** Forget every invoice and delete the files. */
  async clear(): Promise<void> {
    this.entries = [];
    this.waiting = [];
    await rm(this.filesDir, { recursive: true, force: true });
    await mkdir(this.filesDir, { recursive: true });
    this.saveSoon();
  }

  // ── checks ─────────────────────────────────

  /**
   * Run the checks again for invoices from `fromSeq` on. One run at a time, so two invoices
   * finishing together can't overwrite each other's duplicate results.
   */
  private recheck(fromSeq: number, reload: boolean): Promise<void> {
    const run = this.rechecking.then(() => this.recheckNow(fromSeq, reload));
    this.rechecking = run.catch((error) => console.error("Re-check failed:", error));
    return run;
  }

  private async recheckNow(fromSeq: number, reload: boolean): Promise<void> {
    if (reload) await this.accounting.reload();
    await recheckEntries(this.list(), this.matching, fromSeq);
    this.saveSoon();
  }

  // ── the queue ──────────────────────────────

  private enqueue(entry: Entry): void {
    const cleared = !this.entries.includes(entry);
    if (cleared) return;
    entry.state = "QUEUED";
    // XML needs no AI: don't make it wait behind slow AI reads (unless a PO came with it: Bedrock reads that).
    if (entry.ext === ".xml" && !entry.po) {
      void this.readLogged(entry);
      return;
    }
    this.waiting.push(entry);
    this.pump();
  }

  /** Start waiting invoices until every reading slot is busy. */
  private pump(): void {
    while (this.running < config.bedrock.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      this.running++;
      void this.readLogged(entry).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  /** Read and check one invoice; a crash is logged, so the queue keeps going. */
  private readLogged(entry: Entry): Promise<void> {
    return this.readAndCheck(entry).catch((error) => console.error(`Reading ${entry.file} failed:`, error));
  }

  private async readAndCheck(entry: Entry): Promise<void> {
    if (!this.entries.includes(entry)) return;
    entry.state = "READING";
    entry.attempts++;
    entry.updatedAt = Date.now();
    // The PO uploaded with it first. Once read it is kept, so a retry for the invoice doesn't pay for it again.
    if (entry.po && !entry.po.read) {
      const poRead = await this.matching.readPo(await this.readPoFiles(entry));
      if (this.outdated(entry)) return;
      if (poRead.retryable && entry.attempts < config.maxAttempts) {
        this.retryLater(entry, poRead.error);
        return;
      }
      entry.po.read = poRead;
      this.saveSoon();
    }
    const data = await readFile(this.filePath(entry));
    const read = await this.matching.read(entry.file, data);
    if (this.outdated(entry)) return;
    if (read.retryable && entry.attempts < config.maxAttempts) {
      this.retryLater(entry, read.error);
      return;
    }
    entry.read = read;
    entry.retryError = null;
    entry.held = null;
    entry.state = "DONE";
    entry.updatedAt = Date.now();
    await this.recheck(entry.seq, false);
  }

  /** Cleared, or put back in the queue, while its files were being read: that read no longer counts. */
  private outdated(entry: Entry): boolean {
    return !this.entries.includes(entry) || entry.state !== "READING";
  }

  /** The PO files kept with the invoice, for Bedrock. */
  private readPoFiles(entry: Entry): Promise<{ name: string; data: Buffer }[]> {
    const paths = this.poFilePaths(entry);
    return Promise.all(entry.po!.files.map(async (file, i) => ({ name: file.file, data: await readFile(paths[i]) })));
  }

  /** Temporary problem (rate limit, server busy or down): wait, then try again. */
  private retryLater(entry: Entry, error: string | null): void {
    entry.state = "QUEUED";
    entry.retryError = error;
    entry.updatedAt = Date.now();
    this.saveSoon();
    setTimeout(() => this.enqueue(entry), RETRY_DELAY_MS * entry.attempts).unref();
  }

  // ── saving ─────────────────────────────────

  /** Save at most every half second: with hundreds of invoices finishing, one write per change is wasteful. */
  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DELAY_MS);
  }

  /** Write the list now (after any write already under way). */
  private saveNow(): Promise<void> {
    const snapshot = JSON.stringify(this.entries);
    this.saving = this.saving
      .then(() => writeAtomically(this.storeFile, snapshot))
      .catch((error) => console.error("Could not save the invoice list:", error));
    return this.saving;
  }
}

/** An uploaded file the reader takes (`what`: "PO" or "Invoice", for the error), read into memory; else a 400. */
async function accepted(
  incoming: IncomingFile,
  what: string,
  types?: Set<string>,
): Promise<{ incoming: IncomingFile; ext: string; data: Buffer }> {
  const ext = extname(incoming.name).toLowerCase();
  const data = "data" in incoming ? incoming.data : await readFile(incoming.path);
  const reason = skipReason(ext, data.length, types);
  if (reason) throw new BadRequestException(`${what} ${incoming.name}: ${reason}`);
  return { incoming, ext, data };
}
