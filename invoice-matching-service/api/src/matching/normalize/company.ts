import { normId } from "./ids.js";

// Two name matches: normName is exact (to find the supplier on file), sameCompany is fuzzy (for the bill-to name).

/** Company names without "Pte. Ltd." etc., for matching a supplier by name. */
export function normName(name: string): string {
  return normId(name.replace(/\b(pte|private|ltd|limited|llp|co|company|inc)\b\.?/gi, ""));
}

/** Company forms and filler words that don't tell two companies apart. */
const COMPANY_NOISE = new Set(["pte", "private", "ltd", "limited", "pl", "llp", "inc", "co", "company", "the"]);

/** Short forms seen on invoices and POs ("Facilities Mgm" = "Facilities Management", "Rentokil Initial (S)"). */
const COMPANY_ABBR: Record<string, string> = {
  mgt: "management",
  mgmt: "management",
  mgm: "management",
  s: "singapore",
};

/** "Nearly all" the words of the shorter name must be in the other one. */
const MIN_SHARED_WORDS = 0.8;

/** Same company, allowing the usual short forms ("Facilities Mgm Pte Ltd" = "Facilities Management"). */
export function sameCompany(a: string, b: string): boolean {
  const wordsA = companyWords(a);
  const wordsB = companyWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;

  const sharedWords = [...wordsA].filter((word) => wordsB.has(word)).length;
  return sharedWords / Math.min(wordsA.size, wordsB.size) >= MIN_SHARED_WORDS;
}

/** The words of a company name that tell it apart, with short forms spelled out ("&" counts as "and"). */
function companyWords(name: string): Set<string> {
  const words = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .map((word) => COMPANY_ABBR[word] ?? word)
    .filter((word) => word !== "" && !COMPANY_NOISE.has(word));
  return new Set(words);
}
