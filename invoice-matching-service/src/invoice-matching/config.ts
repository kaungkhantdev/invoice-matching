import { Decimal } from "decimal.js";

/** bedrock = Claude on Amazon Bedrock (the production setup) · claude = Claude API · local = your own LLM server. */
export type AiProvider = "bedrock" | "claude" | "local";
export const AI_PROVIDERS: readonly AiProvider[] = ["bedrock", "claude", "local"];

function aiProvider(): AiProvider {
  const value = (process.env.AI_PROVIDER ?? "bedrock").trim().toLowerCase();
  if (!(AI_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(`AI_PROVIDER must be "bedrock", "claude" or "local", got "${process.env.AI_PROVIDER}"`);
  }
  return value as AiProvider;
}

/**
 * Singapore, so invoice data stays in Singapore. Deliberately NOT taken from AWS_REGION: a region set in
 * someone's shell for other work must not send invoices elsewhere. Change it with BEDROCK_REGION / TEXTRACT_REGION.
 */
const SINGAPORE = "ap-southeast-1";

/** A number from .env, or the default when it's missing or not a number (TEXTRACT_MAX_PAGES=abc must not give NaN). */
function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : fallback;
}

/** TEXTRACT=on|off (TEXTRACT_CROSS_CHECK is the old name). On unless switched off. */
function textractOn(): boolean {
  const value = (process.env.TEXTRACT ?? process.env.TEXTRACT_CROSS_CHECK ?? "on").trim().toLowerCase();
  return !["off", "false", "0", "no"].includes(value);
}

const provider = aiProvider();

/** How to talk to the local server: Ollama's own API, or the standard OpenAI-compatible one. */
export type LocalApi = "ollama" | "openai";

const localBaseUrl = (process.env.LOCAL_LLM_BASE_URL ?? "http://localhost:11434/v1").replace(/\/+$/, "");

function localApi(): LocalApi {
  const value = process.env.LOCAL_LLM_API?.trim().toLowerCase();
  if (value === "ollama" || value === "openai") return value;
  if (value) throw new Error(`LOCAL_LLM_API must be "ollama" or "openai", got "${process.env.LOCAL_LLM_API}"`);
  return /:11434(\/|$)/.test(localBaseUrl) ? "ollama" : "openai";
}

/** All settings in one place. Override any of them in .env. */
export const config = {
  /** Singapore GST rate. */
  gstRate: new Decimal(process.env.GST_RATE ?? "0.09"),
  /** Differences up to this amount (in the invoice currency) are "small" (⚠️), above it they fail (❌). */
  tolerance: new Decimal(process.env.ROUNDING_TOLERANCE ?? "1.00"),
  /**
   * Our company names: every invoice must be billed to one of them (BUYER_NAMES, separated by "|").
   * Short forms like "Mgm", "Mgt" and "Pte Ltd" / "PL" are accepted automatically.
   */
  buyerNames: (process.env.BUYER_NAMES ?? "Industrial & Commercial Facilities Management Pte Ltd")
    .split("|")
    .map((n) => n.trim())
    .filter(Boolean),
  /** How similar an invoice line description must be to a PO line (0–1) to count as the same item. */
  lineMatchMinScore: num("LINE_MATCH_MIN_SCORE", 0.5),

  /** Which AI reads PDFs, photos, SVGs and spreadsheets: "bedrock" (default), "claude" (Anthropic API) or "local". */
  aiProvider: provider,

  bedrock: {
    region: process.env.BEDROCK_REGION ?? SINGAPORE,
    /**
     * Claude Sonnet 5 runs In-Region in Singapore, so invoices stay in Singapore.
     * (Newer models such as global.anthropic.claude-opus-5-5 are "Global": data may leave Singapore.)
     */
    model: process.env.BEDROCK_MODEL ?? "anthropic.claude-sonnet-5",
    effort: (process.env.BEDROCK_EFFORT ?? "medium") as "low" | "medium" | "high",
  },

  claude: {
    model: process.env.CLAUDE_MODEL ?? process.env.INVOICE_AI_MODEL ?? "claude-opus-5-5",
    effort: (process.env.CLAUDE_EFFORT ?? process.env.INVOICE_AI_EFFORT ?? "medium") as "low" | "medium" | "high",
  },

  local: {
    /** Any OpenAI-compatible server: Ollama, LM Studio, vLLM, llama.cpp. */
    baseUrl: localBaseUrl,
    /** "ollama" (default for port 11434) or "openai" (LM Studio, vLLM, llama.cpp). */
    api: localApi(),
    /** Ollama only: context size in tokens. Its default (4096 on smaller machines) is too small for long invoices. */
    numCtx: num("LOCAL_LLM_NUM_CTX", 16384),
    /** Must be a vision model to read photos, scans and SVGs. */
    model: process.env.LOCAL_LLM_MODEL ?? "gemma4:12b",
    /** Only if your server needs one (vLLM / LM Studio can be set up with a key). */
    apiKey: process.env.LOCAL_LLM_API_KEY ?? "",
    /** Local models can be slow on a laptop; one invoice may take a minute or more. */
    timeoutMs: num("LOCAL_LLM_TIMEOUT_MS", 300000),
    /** Most pages a scanned PDF is turned into images for (local models can't read PDF files directly). */
    maxPdfPages: Math.floor(num("LOCAL_LLM_MAX_PDF_PAGES", 5)),
  },

  /**
   * How many invoices each AI reads at the same time. Everything else waits in the queue.
   * Bedrock and Claude: limited by your quota / rate limit. Local: by the GPU (raise it only for a server
   * that serves several requests at once, e.g. vLLM, or Ollama with OLLAMA_NUM_PARALLEL).
   */
  concurrency: {
    bedrock: Math.max(1, Math.floor(num("BEDROCK_CONCURRENCY", 8))),
    claude: Math.max(1, Math.floor(num("CLAUDE_CONCURRENCY", 8))),
    local: Math.max(1, Math.floor(num("LOCAL_LLM_CONCURRENCY", 1))),
  },
  /**
   * Amazon Textract (AnalyzeExpense) reads every PDF page, photo and scan first (OCR). Its text goes to the AI
   * with the file, and check 0 compares the invoice no., PO, subtotal, GST, total and GST reg. no. it found
   * with what the AI read. Needs an AWS login. TEXTRACT=off only for trying the app without AWS.
   */
  textract: {
    enabled: textractOn(),
    region: process.env.TEXTRACT_REGION ?? SINGAPORE,
    /** Most PDF pages sent to Textract (one request per page). Later pages are flagged for a person to check. */
    maxPages: Math.max(1, Math.floor(num("TEXTRACT_MAX_PAGES", 5))),
    /** Requests per second allowed by your AWS quota (AnalyzeExpense default in Singapore: 1). */
    tps: Math.max(0.1, num("TEXTRACT_TPS", 1)),
  },
  /** Tries per invoice when the AI is busy, rate-limited or unreachable, before it goes to review. */
  maxAttempts: Math.max(1, Math.floor(num("READ_MAX_ATTEMPTS", 3))),
  dataDir: process.env.DATA_DIR ?? "data",
  /** Where the web UI keeps uploaded files and results. */
  uiStoreDir: process.env.UI_STORE_DIR ?? "output/ui",
};

/** Read concurrency for the default AI (used by the command-line batch run). */
export const readConcurrency = config.concurrency[config.aiProvider];
