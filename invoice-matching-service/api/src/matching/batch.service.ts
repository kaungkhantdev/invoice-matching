import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import type { CheckResult, Outcome } from "./checker/checker.service.js";
import { config } from "../config.js";
import { emptySeen, MatchingService, type InvoiceResult, type ReadResult } from "./matching.service.js";
import { ReaderService } from "./reader/reader.service.js";

const ICON: Record<Outcome, string> = { MATCHED: "✅", MATCHED_WITH_NOTE: "⚠️ ", REVIEW: "❌" };
/** Report columns: the longest outcome name, and the narrowest the file-name column gets. */
const OUTCOME_WIDTH = "MATCHED_WITH_NOTE".length;
const MIN_FILE_WIDTH = 10;

const CSV_HEADER = "file,outcome,read_by,supplier,invoice_number,po_number,currency,total,problems";
/** Text that Excel would run as a formula, unless it is just a (negative) number like -12.50. */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Command-line batch run: every file in a folder → READ → MAP → MATCH → FLAG → report.
 * The API (npm start) runs the same steps for the web page, through MatchingService.
 */
@Injectable()
export class BatchService {
  constructor(
    private readonly matching: MatchingService,
    private readonly reader: ReaderService,
  ) {}

  /** Reads, checks and reports every file in `inputDir`; saves results.json and summary.csv in `outputDir`. */
  async run(inputDir: string, outputDir: string): Promise<InvoiceResult[]> {
    const files = await listFiles(inputDir);
    console.log(`Invoice matching: ${files.length} files in ${inputDir}`);
    console.log(`Reading PDF / photo / Excel / SVG with ${this.reader.describe()}\n`);

    const reads = await this.readAll(inputDir, files);
    const results = await this.checkAll(reads);

    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "results.json"), JSON.stringify(results, null, 2));
    await writeFile(join(outputDir, "summary.csv"), toCsv(results));
    printReport(results, outputDir);
    return results;
  }

  /** 1. READ: the slow part (Textract + Bedrock), several files at a time, with a progress counter. */
  private async readAll(
    inputDir: string,
    files: string[],
  ): Promise<{ file: string; hash: string; read: ReadResult }[]> {
    let done = 0;
    const reads = await mapPool(files, config.bedrock.concurrency, async (file) => {
      const data = await readFile(join(inputDir, file));
      const read = await this.matching.read(file, data);
      done++;
      process.stdout.write(`\rReading ${done}/${files.length}`);
      return { file, hash: this.matching.fingerprint(data), read };
    });
    process.stdout.write("\n\n");
    return reads;
  }

  /** 2. MAP + MATCH + FLAG: in file order, so duplicates are always found the same way. */
  private async checkAll(reads: { file: string; hash: string; read: ReadResult }[]): Promise<InvoiceResult[]> {
    const seen = emptySeen();
    const results: InvoiceResult[] = [];
    for (const { file, hash, read } of reads) {
      const result = await this.matching.check(file, hash, read, seen);
      this.matching.remember(seen, file, hash, result);
      results.push(result);
    }
    return results;
  }
}

/** Run `work` on every item, at most `limit` at a time, keeping the original order. */
export async function mapPool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // Each worker takes the next item until none are left.
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]);
    }
  };
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/** The files to read: every file in the folder except hidden ones (and not sub-folders), by name. */
async function listFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/** A failed (✗) or noted (!) check: the ones the report and the CSV list. */
function isFlagged(check: CheckResult): boolean {
  return check.status === "fail" || check.status === "note";
}

/** The report on screen: one line per file with its flagged checks below it, then the totals. */
function printReport(results: InvoiceResult[], outputDir: string): void {
  const fileWidth = Math.max(...results.map((result) => result.file.length), MIN_FILE_WIDTH);
  for (const result of results) printResult(result, fileWidth);
  const count = (outcome: Outcome) => results.filter((result) => result.outcome === outcome).length;
  const matched = count("MATCHED");
  const withNote = count("MATCHED_WITH_NOTE");
  const review = count("REVIEW");
  console.log(`\nSummary: ${matched} ✅ matched · ${withNote} ⚠️  matched with note · ${review} ❌ review`);
  console.log(`Saved: ${join(outputDir, "results.json")}, ${join(outputDir, "summary.csv")}`);
}

/** One file, e.g. "❌ REVIEW  02-kallang.pdf  Kallang Packaging Pte. Ltd. · KP-88131 · SGD 479.60  [bedrock]". */
function printResult(result: InvoiceResult, fileWidth: number): void {
  const invoice = result.invoice;
  const what = invoice
    ? `${invoice.supplier.name} · ${invoice.invoiceNumber} · ${invoice.currency} ${invoice.total}`
    : "";
  const readBy = result.readBy ? `  [${result.readBy}]` : "";
  const outcome = result.outcome.padEnd(OUTCOME_WIDTH);
  console.log(`${ICON[result.outcome]} ${outcome} ${result.file.padEnd(fileWidth)}  ${what}${readBy}`);
  if (result.error) console.log(`      ✗ Could not read: ${result.error}`);
  for (const check of result.checks.filter(isFlagged)) {
    const mark = check.status === "fail" ? "✗" : "!";
    for (const detail of check.details) console.log(`      ${mark} ${check.name}: ${detail}`);
  }
}

/** summary.csv: one row per file, for Excel. */
function toCsv(results: InvoiceResult[]): string {
  const rows = results.map((result) => csvRow(result).map(csvCell).join(","));
  return [CSV_HEADER, ...rows].join("\n") + "\n";
}

/** One file's row, in the order of CSV_HEADER. */
function csvRow(result: InvoiceResult): (string | null | undefined)[] {
  const problems = [
    ...(result.error ? [`Could not read: ${result.error}`] : []),
    ...result.checks.filter(isFlagged).flatMap((check) => check.details.map((detail) => `${check.name}: ${detail}`)),
  ].join(" | ");
  const invoice = result.invoice;
  return [
    result.file,
    result.outcome,
    result.readBy,
    invoice?.supplier.name,
    invoice?.invoiceNumber,
    invoice?.poNumber,
    invoice?.currency,
    invoice?.total,
    problems,
  ];
}

/** A quoted CSV cell. Text from invoices can start with "=" etc.: prefix it so Excel shows it instead of running it. */
function csvCell(value: string | null | undefined): string {
  const text = String(value ?? "");
  const looksLikeFormula = FORMULA_START.test(text) && !PLAIN_NUMBER.test(text);
  const safe = looksLikeFormula ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
