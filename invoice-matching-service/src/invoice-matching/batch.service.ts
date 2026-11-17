import { Injectable } from "@nestjs/common";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Outcome } from "./checker/checker.service.js";
import { config, readConcurrency } from "./config.js";
import { emptySeen, MatchingService, type InvoiceResult } from "./matching.service.js";
import { ReaderService } from "./reader/reader.service.js";

/** Run `work` on every item, at most `limit` at a time, keeping the original order. */
export async function mapPool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const ICON: Record<Outcome, string> = { MATCHED: "✅", MATCHED_WITH_NOTE: "⚠️ ", REVIEW: "❌" };

/**
 * Command-line batch run: every file in a folder → READ → MAP → MATCH → FLAG → report.
 * The web UI (npm run ui) runs the same steps through MatchingService.
 */
@Injectable()
export class BatchService {
  constructor(
    private readonly matching: MatchingService,
    private readonly reader: ReaderService,
  ) {}

  async run(inputDir: string, outputDir: string): Promise<InvoiceResult[]> {
    const files = (await readdir(inputDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    console.log(`Invoice matching: ${files.length} files in ${inputDir}`);
    console.log(`AI for PDF / photo / Excel / SVG: ${this.reader.describeAi()} (AI_PROVIDER=${config.aiProvider})\n`);

    // 1. READ: the slow part (AI), several files at a time.
    let done = 0;
    const reads = await mapPool(files, readConcurrency, async (file) => {
      const data = await readFile(join(inputDir, file));
      const read = await this.matching.read(file, data);
      done++;
      process.stdout.write(`\rReading ${done}/${files.length}`);
      return { file, hash: this.matching.fingerprint(data), read };
    });
    process.stdout.write("\n\n");

    // 2. MAP + MATCH + FLAG: in file order, so duplicates are always found the same way.
    const seen = emptySeen();
    const results: InvoiceResult[] = [];
    for (const r of reads) {
      const result = await this.matching.check(r.file, r.hash, r.read, seen);
      this.matching.remember(seen, r.file, r.hash, result);
      results.push(result);
    }

    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "results.json"), JSON.stringify(results, null, 2));
    await writeFile(join(outputDir, "summary.csv"), this.toCsv(results));
    this.print(results, outputDir);
    return results;
  }

  private print(results: InvoiceResult[], outputDir: string): void {
    const width = Math.max(...results.map((r) => r.file.length), 10);
    for (const r of results) {
      const inv = r.invoice;
      const what = inv ? `${inv.supplier.name} · ${inv.invoiceNumber} · ${inv.currency} ${inv.total}` : "";
      console.log(`${ICON[r.outcome]} ${r.outcome.padEnd(17)} ${r.file.padEnd(width)}  ${what}${r.readBy ? `  [${r.readBy}]` : ""}`);
      if (r.error) console.log(`      ✗ Could not read: ${r.error}`);
      for (const c of r.checks) {
        if (c.status !== "fail" && c.status !== "note") continue;
        const mark = c.status === "fail" ? "✗" : "!";
        for (const d of c.details) console.log(`      ${mark} ${c.name}: ${d}`);
      }
    }
    const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
    console.log(
      `\nSummary: ${count("MATCHED")} ✅ matched · ${count("MATCHED_WITH_NOTE")} ⚠️  matched with note · ${count("REVIEW")} ❌ review`,
    );
    console.log(`Saved: ${join(outputDir, "results.json")}, ${join(outputDir, "summary.csv")}`);
  }

  private toCsv(results: InvoiceResult[]): string {
    // Text from invoices can start with "=" etc.: prefix it so Excel shows it instead of running it as a formula.
    const q = (v: string | null | undefined) => {
      const s = String(v ?? "");
      const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const header = ["file", "outcome", "read_by", "supplier", "invoice_number", "po_number", "currency", "total", "problems"];
    const rows = results.map((r) => {
      const problems = [
        ...(r.error ? [`Could not read: ${r.error}`] : []),
        ...r.checks.filter((c) => c.status === "fail" || c.status === "note").flatMap((c) => c.details.map((d) => `${c.name}: ${d}`)),
      ].join(" | ");
      const inv = r.invoice;
      return [r.file, r.outcome, r.readBy, inv?.supplier.name, inv?.invoiceNumber, inv?.poNumber, inv?.currency, inv?.total, problems]
        .map(q)
        .join(",");
    });
    return [header.join(","), ...rows].join("\n") + "\n";
  }
}
