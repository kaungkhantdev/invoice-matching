import { BadRequestException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { AccountingSource } from "../invoice-matching/accounting/accounting.source.js";
import { AI_PROVIDERS, config, type AiProvider } from "../invoice-matching/config.js";
import { emptySeen, MatchingService, type Claims, type InvoiceResult, type ReadResult } from "../invoice-matching/matching.service.js";
import { SUPPORTED } from "../invoice-matching/reader/file-prep.js";

export type EntryState = "QUEUED" | "READING" | "DONE";

export interface Decision {
  status: "APPROVED" | "REJECTED";
  note: string;
  at: string;
  /** The result the person saw when deciding. If a re-check changes it, the decision is cleared. */
  outcome: string;
}

export interface Entry {
  id: string;
  /** Order the invoice arrived in. The later copy of a duplicate is the one flagged. */
  seq: number;
  file: string;
  ext: string;
  hash: string;
  size: number;
  addedAt: string;
  provider: AiProvider;
  state: EntryState;
  /** Reading tries so far (temporary errors are retried up to READ_MAX_ATTEMPTS). */
  attempts: number;
  /** The last temporary error, while waiting to try again. */
  retryError: string | null;
  read: ReadResult | null;
  result: InvoiceResult | null;
  /** While it is read again: what the last result held (invoice key, PO), so later copies stay flagged meanwhile. */
  held?: Claims | null;
  decision: Decision | null;
  updatedAt: number;
}

/** A file to add: either already in memory, or a temporary file on disk (big uploads). */
export type IncomingFile = { name: string; data: Buffer } | { name: string; path: string };

export const ACCEPTED = new Set([...SUPPORTED, ".xml"]);
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Wait before trying again after a temporary error: 30 s, then 60 s, … */
const RETRY_DELAY_MS = 30_000;

/**
 * The invoice queue behind the web UI: files, what was read, check results and decisions.
 *
 * Any number of invoices can arrive at once (e.g. 700 at month end). They are saved and queued
 * immediately; each AI reads at most `config.concurrency[provider]` at a time; temporary errors
 * are retried with a pause. Kept in UI_STORE_DIR (default output/ui) so a restart picks up where
 * it left off. In the full system this becomes a database table (see ARCHITECTURE.md).
 */
@Injectable()
export class InvoiceStore implements OnModuleInit {
  private readonly dir = resolve(config.uiStoreDir);
  private readonly filesDir = join(this.dir, "files");
  private entries: Entry[] = [];
  private nextSeq = 1;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();
  private rechecking: Promise<void> = Promise.resolve();
  private readonly waiting: Record<AiProvider, Entry[]> = { bedrock: [], claude: [], local: [] };
  private readonly running: Record<AiProvider, number> = { bedrock: 0, claude: 0, local: 0 };

  constructor(
    private readonly matching: MatchingService,
    private readonly accounting: AccountingSource,
  ) {}

  async onModuleInit(): Promise<void> {
    await mkdir(this.filesDir, { recursive: true });
    const storeFile = join(this.dir, "store.json");
    if (existsSync(storeFile)) {
      this.entries = (JSON.parse(await readFile(storeFile, "utf8")) as Entry[]).map((e) => ({
        ...e,
        attempts: e.attempts ?? 0,
        retryError: e.retryError ?? null,
      }));
      this.nextSeq = Math.max(0, ...this.entries.map((e) => e.seq)) + 1;
      // Anything that was waiting or being read when the server stopped goes back in the queue.
      for (const e of this.list()) if (e.state !== "DONE") this.enqueue(e);
    }
  }

  list(): Entry[] {
    return [...this.entries].sort((a, b) => a.seq - b.seq);
  }

  get(id: string): Entry {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new NotFoundException(`No invoice with id ${id}`);
    return entry;
  }

  filePath(entry: Entry): string {
    return join(this.filesDir, `${entry.id}${entry.ext}`);
  }

  /** How many are waiting / being read per AI (for the status line). */
  queueStats() {
    return {
      bedrock: { waiting: this.waiting.bedrock.length, reading: this.running.bedrock, limit: config.concurrency.bedrock },
      claude: { waiting: this.waiting.claude.length, reading: this.running.claude, limit: config.concurrency.claude },
      local: { waiting: this.waiting.local.length, reading: this.running.local, limit: config.concurrency.local },
    };
  }

  /** Add files. Each is saved and queued right away; the chosen AI reads them in the background (XML needs none). */
  async add(files: IncomingFile[], provider: AiProvider): Promise<{ added: Entry[]; skipped: string[] }> {
    const added: Entry[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const ext = extname(f.name).toLowerCase();
      const data = "data" in f ? f.data : await readFile(f.path);
      if (!ACCEPTED.has(ext)) {
        skipped.push(`${f.name}: file type not supported`);
        if ("path" in f) await rm(f.path, { force: true });
        continue;
      }
      if (data.length > MAX_FILE_BYTES) {
        skipped.push(`${f.name}: larger than 25 MB`);
        if ("path" in f) await rm(f.path, { force: true });
        continue;
      }
      const entry: Entry = {
        id: randomUUID(),
        seq: this.nextSeq++,
        file: f.name,
        ext,
        hash: this.matching.fingerprint(data),
        size: data.length,
        addedAt: new Date().toISOString(),
        provider,
        state: "QUEUED",
        attempts: 0,
        retryError: null,
        read: null,
        result: null,
        decision: null,
        updatedAt: Date.now(),
      };
      if ("path" in f) await moveFile(f.path, this.filePath(entry));
      else await writeFile(this.filePath(entry), data);
      this.entries.push(entry);
      added.push(entry);
    }
    // Save first, read later: the list is on disk before any AI touches these invoices.
    await this.saveNow();
    for (const entry of added) this.enqueue(entry);
    return { added, skipped };
  }

  async addSamples(provider: AiProvider): Promise<{ added: Entry[]; skipped: string[] }> {
    const dir = join(process.cwd(), "samples", "invoices");
    if (!existsSync(dir)) throw new NotFoundException('No sample invoices yet. Run "npm run samples" first.');
    const names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
    const files = await Promise.all(names.map(async (name) => ({ name, data: await readFile(join(dir, name)) })));
    return this.add(files, provider);
  }

  /** Read the file again, e.g. with another AI. (While the app runs, Textract's pages are reused, not paid for again.) */
  reread(id: string, provider: AiProvider): Entry {
    const entry = this.get(id);
    if (entry.state !== "DONE") return entry;
    const held = entry.result ? this.matching.claims(entry.result) : null;
    Object.assign(entry, { provider, attempts: 0, retryError: null, read: null, result: null, held, decision: null, updatedAt: Date.now() });
    this.enqueue(entry);
    void this.recheck(entry.seq, false);
    return entry;
  }

  decide(id: string, status: Decision["status"], note: string): Entry {
    const entry = this.get(id);
    if (entry.state !== "DONE" || !entry.result) throw new BadRequestException("This invoice hasn't been read yet");
    entry.decision = { status, note: note.slice(0, 500), at: new Date().toISOString(), outcome: entry.result.outcome };
    entry.updatedAt = Date.now();
    this.saveSoon();
    return entry;
  }

  /** Reload suppliers and POs from data/ and run every check again (no AI). */
  recheckAll(): Promise<void> {
    return this.recheck(0, true);
  }

  async clear(): Promise<void> {
    this.entries = [];
    for (const provider of AI_PROVIDERS) this.waiting[provider] = [];
    await rm(this.filesDir, { recursive: true, force: true });
    await mkdir(this.filesDir, { recursive: true });
    this.saveSoon();
  }

  // ── checks ───────────────────────────────────────────────────────────

  /**
   * Run the checks again for invoices from `fromSeq` on. Earlier invoices are unchanged, so they're
   * only remembered for the duplicate check. One run at a time, so two invoices finishing together
   * can't overwrite each other's duplicate results.
   */
  private recheck(fromSeq: number, reload: boolean): Promise<void> {
    const run = this.rechecking.then(() => this.recheckNow(fromSeq, reload));
    this.rechecking = run.catch((error) => console.error("Re-check failed:", error));
    return run;
  }

  private async recheckNow(fromSeq: number, reload: boolean): Promise<void> {
    if (reload) await this.accounting.reload();
    const seen = emptySeen();
    for (const e of this.list()) {
      if (e.state !== "DONE" || !e.read) {
        // Not read yet, but its file fingerprint is known: a later identical file is a duplicate right away.
        // Being read again: it still holds its invoice and PO until the new result is in.
        if (e.held) this.matching.remember(seen, e.file, e.hash, e.held);
        else if (!seen.byHash.has(e.hash)) seen.byHash.set(e.hash, e.file);
        continue;
      }
      if (e.seq < fromSeq && e.result) {
        this.matching.remember(seen, e.file, e.hash, e.result);
        continue;
      }
      let result: InvoiceResult;
      try {
        result = await this.matching.check(e.file, e.hash, e.read, seen);
      } catch (error) {
        // e.g. a broken data/ file: show it on this invoice instead of stopping the server.
        result = {
          file: e.file,
          outcome: "REVIEW",
          readBy: e.read.readBy,
          model: e.read.model,
          invoice: null,
          checks: [],
          error: `The checks failed: ${error instanceof Error ? error.message : String(error)}`,
          context: null,
          invoiceKey: null,
        };
      }
      this.matching.remember(seen, e.file, e.hash, result);
      if (JSON.stringify(result) !== JSON.stringify(e.result)) {
        e.result = result;
        e.updatedAt = Date.now();
        // A decision was made on the old result: it no longer applies.
        if (e.decision && e.decision.outcome !== result.outcome) e.decision = null;
      }
    }
    this.saveSoon();
  }

  // ── the queue ────────────────────────────────────────────────────────

  private enqueue(entry: Entry): void {
    if (!this.entries.includes(entry)) return; // cleared meanwhile
    entry.state = "QUEUED";
    // XML needs no AI: don't make it wait behind slow AI reads.
    if (entry.ext === ".xml") {
      void this.process(entry).catch((error) => console.error(`Reading ${entry.file} failed:`, error));
      return;
    }
    this.waiting[entry.provider].push(entry);
    this.pump(entry.provider);
  }

  private pump(provider: AiProvider): void {
    while (this.running[provider] < config.concurrency[provider] && this.waiting[provider].length > 0) {
      const entry = this.waiting[provider].shift()!;
      this.running[provider]++;
      void this.process(entry)
        .catch((error) => console.error(`Reading ${entry.file} failed:`, error))
        .finally(() => {
          this.running[provider]--;
          this.pump(provider);
        });
    }
  }

  private async process(entry: Entry): Promise<void> {
    if (!this.entries.includes(entry)) return;
    entry.state = "READING";
    entry.attempts++;
    entry.updatedAt = Date.now();
    const data = await readFile(this.filePath(entry));
    const read = await this.matching.read(entry.file, data, entry.provider);
    if (!this.entries.includes(entry) || entry.state !== "READING") return;

    // Temporary problem (rate limit, server busy or down): wait, then try again.
    if (read.retryable && entry.attempts < config.maxAttempts) {
      entry.state = "QUEUED";
      entry.retryError = read.error;
      entry.updatedAt = Date.now();
      this.saveSoon();
      setTimeout(() => this.enqueue(entry), RETRY_DELAY_MS * entry.attempts).unref();
      return;
    }

    entry.read = read;
    entry.retryError = null;
    entry.held = null;
    entry.state = "DONE";
    entry.updatedAt = Date.now();
    await this.recheck(entry.seq, false);
  }

  // ── saving ───────────────────────────────────────────────────────────

  /** Save at most every half second: with hundreds of invoices finishing, one write per change is wasteful. */
  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 500);
  }

  /** Write the list now (after any write already under way). */
  private saveNow(): Promise<void> {
    const snapshot = JSON.stringify(this.entries);
    const file = join(this.dir, "store.json");
    // Write to a temporary file, then rename: a crash mid-write can't leave a broken store.json.
    this.saving = this.saving
      .then(async () => {
        await writeFile(`${file}.tmp`, snapshot);
        await rename(`${file}.tmp`, file);
      })
      .catch((error) => console.error("Could not save the invoice list:", error));
    return this.saving;
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    // Different disk (e.g. /tmp): copy, then remove.
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}
