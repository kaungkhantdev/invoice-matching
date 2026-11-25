import type { Decimal } from "decimal.js";
import { config } from "../../config.js";
import { fmt, round2 } from "../normalize.js";
import type { CheckResult, CheckStatus } from "./types.js";

/** One thing a check found, and how bad it is. */
export interface Finding {
  status: CheckStatus;
  text: string;
}

/** From least to most serious: the worst finding sets the check's status. */
const RANK: Record<CheckStatus, number> = { skip: 0, pass: 1, note: 2, fail: 3 };

/** A check's result from its findings. Nulls (nothing to report) are left out. */
export function checkResult(
  id: number,
  name: string,
  findings: (Finding | null)[],
  whenEmpty: CheckStatus = "pass",
): CheckResult {
  const found = findings.filter((finding): finding is Finding => finding !== null);
  return { id, name, status: worst(found, whenEmpty), details: found.map((finding) => finding.text) };
}

/** The most serious status among the findings, or `whenEmpty` when there are none. */
export function worst(findings: Finding[], whenEmpty: CheckStatus = "pass"): CheckStatus {
  return findings.reduce<CheckStatus>(
    (worstSoFar, finding) => (RANK[finding.status] > RANK[worstSoFar] ? finding.status : worstSoFar),
    whenEmpty,
  );
}

/** Same amount → nothing to report (null), small difference → note, big difference → fail. */
export function compare(label: string, actual: Decimal, expected: Decimal): Finding | null {
  const want = round2(expected);
  const difference = actual.minus(want).abs();
  if (difference.isZero()) return null;
  const text = `${label}: invoice says ${fmt(actual)}, should be ${fmt(want)} (difference ${fmt(difference)})`;
  return { status: difference.lte(config.tolerance) ? "note" : "fail", text };
}
