// Cleaning a read invoice, and the comparisons the checks use. The code lives in ./normalize/.
// Re-exported so existing imports keep working.
export { cleanAmount, D, fmt, round2 } from "./normalize/amounts.js";
export { isIsoDate, toIsoDate } from "./normalize/dates.js";
export { digits, knownAccount, normId, sameId } from "./normalize/ids.js";
export { sameSite } from "./normalize/site.js";
export { normName, sameCompany } from "./normalize/company.js";
export { normalizeInvoice } from "./normalize/invoice.js";
export { pricesIncludeTaxFromNumbers } from "./normalize/tax.js";
