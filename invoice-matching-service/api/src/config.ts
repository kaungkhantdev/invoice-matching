import { Decimal } from "decimal.js";

/**
 * Singapore, so invoice data stays in Singapore. Deliberately NOT taken from AWS_REGION: a region set in
 * someone's shell for other work must not send invoices elsewhere. Change it with BEDROCK_REGION / TEXTRACT_REGION.
 */
const SINGAPORE = "ap-southeast-1";

/**
 * All settings in one place. Override any of them in .env; none is needed except the AWS login.
 * A setting that is missing or left blank (GST_RATE=) uses the default written here.
 */
export const config = {
  /** Singapore GST rate. */
  gstRate: decimalFromEnv("GST_RATE", "0.09"),
  /** Differences up to this amount (in the invoice currency) are "small" (⚠️), above it they fail (❌). */
  tolerance: decimalFromEnv("ROUNDING_TOLERANCE", "1.00"),
  /**
   * Our company names: every invoice must be billed to one of them (BUYER_NAMES, separated by "|").
   * Short forms like "Mgm", "Mgt" and "Pte Ltd" / "PL" are accepted automatically.
   */
  buyerNames: namesFromEnv("BUYER_NAMES", "Industrial & Commercial Facilities Management Pte Ltd"),
  /** How similar an invoice line description must be to a PO line (0–1) to count as the same item. */
  lineMatchMinScore: numberFromEnv("LINE_MATCH_MIN_SCORE", 0.5),

  /** Claude on Amazon Bedrock: reads each invoice (the file + Textract's text) into our standard invoice. */
  bedrock: {
    region: textFromEnv("BEDROCK_REGION", SINGAPORE),
    /**
     * Claude Sonnet 5 runs In-Region in Singapore, so invoices stay in Singapore.
     * (Newer models such as global.anthropic.claude-opus-5-5 are "Global": data may leave Singapore.)
     */
    model: textFromEnv("BEDROCK_MODEL", "anthropic.claude-sonnet-5"),
    effort: textFromEnv("BEDROCK_EFFORT", "medium") as "low" | "medium" | "high",
    /** Invoices read at the same time (up to your Bedrock quota). Everything else waits in the queue. */
    concurrency: countFromEnv("BEDROCK_CONCURRENCY", 8),
  },

  /**
   * Amazon Textract (AnalyzeExpense) reads every PDF page, photo and scan first (OCR). Its text goes to Bedrock
   * with the file, and check 0 compares the invoice no., PO, subtotal, GST, total and GST reg. no. it found
   * with what Bedrock read.
   */
  textract: {
    region: textFromEnv("TEXTRACT_REGION", SINGAPORE),
    /** Most PDF pages sent to Textract (one request per page). Later pages are flagged for a person to check. */
    maxPages: countFromEnv("TEXTRACT_MAX_PAGES", 5),
    /** Requests per second allowed by your AWS quota (AnalyzeExpense default in Singapore: 1). */
    tps: Math.max(0.1, numberFromEnv("TEXTRACT_TPS", 1)),
  },
  /** Tries per invoice when Textract or Bedrock is busy, rate-limited or unreachable, before it goes to review. */
  maxAttempts: countFromEnv("READ_MAX_ATTEMPTS", 3),
  /** The supplier, PO and recorded-invoice JSON files (see JsonAccountingSource). */
  dataDir: textFromEnv("DATA_DIR", "data"),
  /** Where the web UI keeps uploaded files and results. */
  uiStoreDir: textFromEnv("UI_STORE_DIR", "output/ui"),

  /** The server's port (main.ts). */
  port: numberFromEnv("PORT", 3000),
  /** 127.0.0.1: this computer only. Docker sets 0.0.0.0 inside the container (compose.yaml still publishes to this computer only). */
  host: textFromEnv("HOST", "127.0.0.1"),
  /**
   * Where the page is opened (WEB_ORIGINS, separated by "|"). The API answers browsers on these addresses only
   * (and on its own). Default: the page's dev server (web: npm run dev).
   */
  webOrigins: originsFromEnv("WEB_ORIGINS", "http://localhost:5173|http://127.0.0.1:5173"),
};

/** Text from .env, or the default when it's missing or blank (HOST= must not mean "listen on every network"). */
function textFromEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

/** Names separated by "|" (BUYER_NAMES), or the default when none are given. */
function namesFromEnv(name: string, fallback: string): string[] {
  const names = textFromEnv(name, fallback)
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return names.length ? names : [fallback];
}

/** Web addresses (WEB_ORIGINS) as http(s)://host:port. A typo stops the app at start, naming the setting. */
function originsFromEnv(name: string, fallback: string): string[] {
  return namesFromEnv(name, fallback).map((origin) => {
    const url = URL.parse(origin);
    if (url && (url.protocol === "http:" || url.protocol === "https:") && url.host) return url.origin;
    throw new Error(`${name} must be web addresses like http://localhost:5173, not "${origin}" (check .env)`);
  });
}

/** An amount or rate from .env. A typo stops the app at start, naming the setting, rather than using a wrong rate. */
function decimalFromEnv(name: string, fallback: string): Decimal {
  const raw = textFromEnv(name, fallback);
  try {
    const value = new Decimal(raw);
    if (value.isFinite()) return value;
  } catch {
    // Not a number: said below.
  }
  throw new Error(`${name} must be a number like ${fallback}, not "${raw}" (check .env)`);
}

/** A number from .env, or the default when it's missing, blank or not a number (TEXTRACT_MAX_PAGES=abc must not give NaN). */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : fallback;
}

/** A whole number of at least 1 from .env, for counts (pages, tries, invoices at a time): 2.7 → 2, 0 → 1. */
function countFromEnv(name: string, fallback: number): number {
  return Math.max(1, Math.floor(numberFromEnv(name, fallback)));
}
