/** A real calendar date written YYYY-MM-DD ("2026-02-30" is not). */
export function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

/** DD/MM/YYYY, the Singapore way: "05/11/2026", "5/11/2026", "05-11-2026" or "05.11.2026" (one separator). */
const DAY_MONTH_YEAR = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;

/**
 * A date as our PO page shows it, as YYYY-MM-DD: "05/11/2026" → "2026-11-05" (day first).
 * Code turns it around, not the AI, so day and month can't be swapped. Only DD/MM/YYYY is taken: a date the AI
 * already turned into YYYY-MM-DD (it may have swapped day and month), or anything else, is null.
 */
export function toIsoDate(shown: string): string | null {
  const parts = DAY_MONTH_YEAR.exec(shown.trim());
  if (!parts) return null;
  const [, day, , month, year] = parts;
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isIsoDate(date) ? date : null;
}
