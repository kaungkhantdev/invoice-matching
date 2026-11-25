/** Uppercase letters and digits only, for comparing IDs ("PO 2026/0101" ≈ "po-2026-0101"). */
export const normId = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Same UEN or GST reg. no., ignoring case, spaces and dashes. */
export const sameId = (a: string, b: string) => normId(a) === normId(b);

/** Digits only, for comparing bank account numbers. */
export const digits = (text: string) => text.replace(/\D/g, "");

/** The account is one of those on file (digits only, so spaces and dashes don't matter). */
export const knownAccount = (account: string, onFile: string[]) =>
  onFile.some((accountOnFile) => digits(accountOnFile) === digits(account));
