/** Address short forms, so "2 Changi South St 2" = "2 Changi South Street 2". */
const ADDRESS_ABBR: Record<string, string> = {
  st: "street", rd: "road", ave: "avenue", av: "avenue", cres: "crescent", dr: "drive", ctr: "centre",
  center: "centre", ind: "industrial", bldg: "building", jln: "jalan", lor: "lorong", tce: "terrace", cl: "close",
  ln: "lane", sq: "square", pk: "park", nth: "north", sth: "south", upp: "upper", pl: "place", bt: "bukit",
  tg: "tanjong", kg: "kampong",
};

/** Words that say nothing about which site it is ("Blk", "No", "#", company forms). */
const ADDRESS_NOISE = new Set(["blk", "block", "no", "unit", "level", "lvl", "singapore", "sg", "pte", "ltd"]);

/** A Singapore postal code: 6 digits, also when written "S486759" or "Singapore486759". */
const POSTAL = /(?<!\d)\d{6}(?!\d)/g;

/** "Nearly all" the words of the shorter address must be in the longer one. */
const MIN_SHARED_WORDS = 0.8;

/**
 * Same site? Singapore postal codes decide when both addresses have one. Otherwise every number of the shorter
 * address (house, street, unit) must be in the longer one, as many times as it appears, and nearly all its words too
 * ("2 Changi South Street 2" = "SLC 1, 2 Changi South Street 2"; but not "8 Changi South Street 2", nor "No 5 …").
 */
export function sameSite(a: string, b: string): boolean {
  const postalA = postalCodes(a);
  const postalB = postalCodes(b);
  const bothHavePostalCodes = postalA.length > 0 && postalB.length > 0;
  if (bothHavePostalCodes) return postalA.some((code) => postalB.includes(code));

  const partsA = addressParts(a);
  const partsB = addressParts(b);
  const [shorter, longer] = partCount(partsA) <= partCount(partsB) ? [partsA, partsB] : [partsB, partsA];
  if (shorter.words.size === 0) return false;
  if (!containsEveryNumber(longer.numbers, shorter.numbers)) return false;

  const sharedWords = [...shorter.words].filter((word) => longer.words.has(word)).length;
  return sharedWords / shorter.words.size >= MIN_SHARED_WORDS;
}

function postalCodes(address: string): string[] {
  return address.match(POSTAL) ?? [];
}

type AddressParts = { numbers: string[]; words: Set<string> };

/** The numbers (house, street, unit) and the words of an address, with short forms spelled out and noise left out. */
function addressParts(address: string): AddressParts {
  const tokens = address
    .toLowerCase()
    // Postal codes are compared on their own (above), so they are not house or unit numbers.
    .replace(/s?(?<!\d)\d{6}(?!\d)/gi, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => ADDRESS_ABBR[token] ?? token)
    .filter((token) => !ADDRESS_NOISE.has(token));
  return {
    numbers: tokens.filter((token) => /\d/.test(token)),
    words: new Set(tokens.filter((token) => !/\d/.test(token))),
  };
}

/** How much an address says, to tell the shorter of two addresses. */
function partCount(parts: AddressParts): number {
  return parts.words.size + parts.numbers.length;
}

/** Each number is in the pool, as many times as it appears ("2 Changi South Street 2" needs two 2s). */
function containsEveryNumber(pool: string[], numbers: string[]): boolean {
  const unused = [...pool];
  for (const token of numbers) {
    const i = unused.indexOf(token);
    if (i < 0) return false;
    unused.splice(i, 1);
  }
  return true;
}
