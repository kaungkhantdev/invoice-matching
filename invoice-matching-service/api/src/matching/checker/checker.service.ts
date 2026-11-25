import { Injectable } from "@nestjs/common";
import type { PurchaseOrder } from "../accounting/accounting.source.js";
import type { StandardInvoice } from "../invoice.schema.js";
import { readClearly } from "./checks/0-read-clearly.js";
import { mathAddsUp } from "./checks/1-math.js";
import { poExists } from "./checks/2-po-exists.js";
import { linesMatch } from "./checks/3-lines-match.js";
import { totalMatchesPo } from "./checks/4-total.js";
import { notDuplicate } from "./checks/5-not-duplicate.js";
import { supplierIsReal } from "./checks/6-supplier.js";
import { compareLines, matchLines } from "./lines.js";
import type { CheckContext, CheckResult, LineComparison, Outcome } from "./types.js";

// Re-exported so existing imports keep working.
export type { CheckContext, CheckResult, CheckStatus, LineComparison, Outcome, PoFoundBy } from "./types.js";
export { similarity } from "./similarity.js";

/**
 * The 7 checks (0–6). Plain rules, no AI, so every result can be explained.
 * Each check is in its own file under checks/, numbered like on the page.
 */
@Injectable()
export class CheckerService {
  /** Runs checks 0–6 on one invoice, in the order the page shows them. */
  run(invoice: StandardInvoice, context: CheckContext): CheckResult[] {
    const lineMatches = matchLines(invoice, context.po);
    return [
      readClearly(invoice, context),
      mathAddsUp(invoice),
      poExists(invoice, context),
      linesMatch(invoice, context, lineMatches),
      totalMatchesPo(invoice, context, lineMatches),
      notDuplicate(invoice, context),
      supplierIsReal(invoice, context),
    ];
  }

  /** The verdict for the whole invoice: any fail → REVIEW, else any note → MATCHED_WITH_NOTE. */
  outcome(checks: CheckResult[]): Outcome {
    const statuses = checks.map((check) => check.status);
    if (statuses.includes("fail")) return "REVIEW";
    if (statuses.includes("note")) return "MATCHED_WITH_NOTE";
    return "MATCHED";
  }

  /** Each invoice line next to its PO line, for check 3 and the review page (compareLines in lines.ts). */
  compareLines(invoice: StandardInvoice, po: PurchaseOrder | null): LineComparison[] {
    return compareLines(invoice, po);
  }
}
