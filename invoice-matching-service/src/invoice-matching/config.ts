import { Decimal } from "decimal.js";

export type AiProvider = "claude" | "local";

function aiProvider(): AiProvider {
  const value = (process.env.AI_PROVIDER ?? "claude").trim().toLowerCase();
  if (value !== "claude" && value !== "local") {
    throw new Error(`AI_PROVIDER must be "claude" or "local", got "${process.env.AI_PROVIDER}"`);
  }
  return value;
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
  /** How similar an invoice line description must be to a PO line (0–1) to count as the same item. */
  lineMatchMinScore: Number(process.env.LINE_MATCH_MIN_SCORE ?? "0.5"),

  /** Which AI reads PDFs, photos, SVGs and spreadsheets: "claude" (Anthropic API) or "local" (your own LLM server). */
  aiProvider: provider,

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
    numCtx: Number(process.env.LOCAL_LLM_NUM_CTX ?? "16384"),
    /** Must be a vision model to read photos, scans and SVGs. */
    model: process.env.LOCAL_LLM_MODEL ?? "gemma4:12b",
    /** Only if your server needs one (vLLM / LM Studio can be set up with a key). */
    apiKey: process.env.LOCAL_LLM_API_KEY ?? "",
    /** Local models can be slow on a laptop; one invoice may take a minute or more. */
    timeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS ?? "300000"),
    /** Most pages a scanned PDF is turned into images for (local models can't read PDF files directly). */
    maxPdfPages: Number(process.env.LOCAL_LLM_MAX_PDF_PAGES ?? "5"),
  },

  /**
   * How many invoices each AI reads at the same time. Everything else waits in the queue.
   * Claude: limited by your API rate limit. Local: by the GPU (raise it only for a server that
   * serves several requests at once, e.g. vLLM, or Ollama with OLLAMA_NUM_PARALLEL).
   */
  concurrency: {
    claude: Math.max(1, Number(process.env.CLAUDE_CONCURRENCY ?? "8")),
    local: Math.max(1, Number(process.env.LOCAL_LLM_CONCURRENCY ?? "1")),
  },
  /** Tries per invoice when the AI is busy, rate-limited or unreachable, before it goes to review. */
  maxAttempts: Math.max(1, Number(process.env.READ_MAX_ATTEMPTS ?? "3")),
  dataDir: process.env.DATA_DIR ?? "data",
  /** Where the web UI keeps uploaded files and results. */
  uiStoreDir: process.env.UI_STORE_DIR ?? "output/ui",
};

/** Read concurrency for the default AI (used by the command-line batch run). */
export const readConcurrency = config.concurrency[config.aiProvider];
