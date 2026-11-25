/** An item name needs at least this many words to count as found inside a longer description. */
const MIN_CONTAINED_WORDS = 2;

/** 0–1: how many words two descriptions share. */
export function similarity(a: string, b: string): number {
  const wordsA = words(a);
  const wordsB = words(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const common = [...wordsA].filter((word) => wordsB.has(word)).length;
  return (2 * common) / (wordsA.size + wordsB.size);
}

/** Best similarity of an invoice line (as read, or without a repeated quantity) to a name. */
export function lineSimilarity(line: { description: string; quantity: string }, name: string): number {
  const scores = descriptionVariants(line.description, line.quantity).map((variant) => similarity(variant, name));
  return Math.max(...scores);
}

/** A description with a quantity repeated at its start ("12 Sign Jumbo Roll" for 12 units) also without it. */
export function descriptionVariants(description: string, quantity: string): string[] {
  const prefix = quantity.trim();
  const startsWithQuantity = prefix !== "" && description.startsWith(`${prefix} `);
  return startsWithQuantity ? [description, description.slice(prefix.length).trim()] : [description];
}

/**
 * Every word of `short` is in `long`
 * ("HWSC EcoWash Pearl Creme -5L" is in "5 HWSC EcoWash Pearl Creme -5L (6 visits p.a.)").
 */
export function allWordsIn(short: string, long: string): boolean {
  const shortWords = words(short);
  const longWords = words(long);
  return shortWords.size >= MIN_CONTAINED_WORDS && [...shortWords].every((word) => longWords.has(word));
}

/** The lowercase words of a text, without punctuation; one-letter words are dropped, single digits are kept. */
function words(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ");
  return new Set(tokens.filter((word) => word.length > 1 || /\d/.test(word)));
}
