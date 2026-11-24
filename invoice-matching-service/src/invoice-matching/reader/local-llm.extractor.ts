import { Agent } from "undici";
import { z } from "zod";
import { config, type LocalApi } from "../config.js";
import { InvoiceSchema, type StandardInvoice } from "../invoice.schema.js";
import { InvoiceExtractor, RetryableError, SYSTEM_PROMPT, instructionWithOcr } from "./extractor.js";
import type { Prepared } from "./file-prep.js";
import { pdfForLocalLlm } from "./pdf.js";

/** Our standard invoice as JSON Schema, so the local server can force its answer into this shape. */
export const INVOICE_JSON_SCHEMA = z.toJSONSchema(InvoiceSchema);

/** One chat message, before it's turned into a server's own format. */
type Msg = { role: "system" | "user" | "assistant"; text: string; images: Buffer[] };
type Answer = { content: string; promptTokens: number | null };
type Check = { ok: true; invoice: StandardInvoice } | { ok: false; error: string };

/**
 * Node's built-in fetch gives up after 300 s without response headers, and a local model only sends them once
 * it has finished. Switch that off, so LOCAL_LLM_TIMEOUT_MS is the only time limit.
 */
const noFetchTimeouts = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** Some servers wrap JSON in ```json fences even when asked not to. */
const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

/**
 * AI_PROVIDER=local — reads invoices with a model on your own machine or server. Invoices never leave your network.
 *
 * Two ways to talk to the server (LOCAL_LLM_API):
 *   ollama  Ollama's own API (default when the URL uses port 11434). Lets us turn "thinking" off (much faster),
 *           set a large enough context (LOCAL_LLM_NUM_CTX), and get an error instead of a silently cut prompt.
 *   openai  The standard OpenAI-compatible API: LM Studio, vLLM, llama.cpp (and Ollama too).
 */
export class LocalLlmExtractor extends InvoiceExtractor {
  readonly provider = "local" as const;
  readonly model = config.local.model;

  /** `fetchFn` and `api` can be replaced in tests. */
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly api: LocalApi = config.local.api,
  ) {
    super();
  }

  async extract(fileName: string, prepared: Prepared, ocr?: string | null): Promise<StandardInvoice> {
    const input = await this.toInput(fileName, prepared);
    const userText = [input.text ? `<file name="${fileName}">\n${input.text}\n</file>` : null, instructionWithOcr(ocr)]
      .filter(Boolean)
      .join("\n\n");
    const messages: Msg[] = [
      { role: "system", text: SYSTEM_PROMPT, images: [] },
      { role: "user", text: userText, images: input.images },
    ];

    // Smaller local models sometimes return an answer that doesn't fit: say what was wrong and try once more.
    for (let attempt = 1; ; attempt++) {
      const answer = this.api === "ollama" ? await this.chatOllama(messages) : await this.chatOpenAi(messages);
      this.failIfInputWasCut(SYSTEM_PROMPT + userText, answer.promptTokens);
      const check = this.check(answer.content);
      if (check.ok) {
        if (input.notRead) check.invoice.uncertainFields.push(input.notRead);
        return check.invoice;
      }
      if (attempt >= 2) throw new Error(`Local LLM answer didn't fit our invoice structure: ${check.error}`);
      messages.push(
        { role: "assistant", text: answer.content, images: [] },
        { role: "user", text: `That answer doesn't fit the structure (${check.error}). Reply again with the complete JSON only.`, images: [] },
      );
    }
  }

  /** Local models can't read PDF files: text pages are sent as text, scanned pages as images. */
  private async toInput(
    fileName: string,
    prepared: Prepared,
  ): Promise<{ text: string | null; images: Buffer[]; notRead: string | null }> {
    if (prepared.kind === "image") return { text: null, images: [prepared.data], notRead: null };
    if (prepared.kind === "text") return { text: prepared.text, images: [], notRead: null };
    const pdf = await pdfForLocalLlm(prepared.data, config.local.maxPdfPages);
    return {
      text: pdf.text,
      images: pdf.images,
      // Never silently skip pages: a person must check the pages the AI didn't see.
      notRead:
        pdf.skippedPages > 0
          ? `${pdf.skippedPages} scanned page(s) of ${fileName} not read (LOCAL_LLM_MAX_PDF_PAGES=${config.local.maxPdfPages})`
          : null,
    };
  }

  /**
   * A server may silently drop part of a prompt that is longer than the model's context (Ollama's
   * OpenAI-compatible API does this). If far fewer tokens were read than the text we sent, stop:
   * an invoice read from half a prompt can't be trusted.
   */
  private failIfInputWasCut(text: string, promptTokens: number | null): void {
    // A safe lower bound for any tokenizer: about 4 letters per token, and at most 3 digits per token.
    const digitCount = (text.match(/\d/g) ?? []).length;
    const expectedAtLeast = Math.floor(digitCount / 3 + (text.length - digitCount) / 4);
    if (promptTokens !== null && promptTokens < expectedAtLeast * 0.7) {
      throw new Error(
        `The local LLM only read ${promptTokens} of about ${expectedAtLeast}+ tokens: its context is too small for this invoice. ` +
          "Raise it (Ollama: LOCAL_LLM_API=ollama with LOCAL_LLM_NUM_CTX=16384, or OLLAMA_CONTEXT_LENGTH).",
      );
    }
  }

  // ── Ollama's own API ──────────────────────────────────────────────────

  private async chatOllama(messages: Msg[]): Promise<Answer> {
    const origin = config.local.baseUrl.replace(/\/v1$/, "");
    const json = (await this.post(`${origin}/api/chat`, {
      model: this.model,
      stream: false,
      think: false, // "thinking" costs ~10× the time and isn't needed to copy fields
      truncate: false, // error instead of silently cutting a long prompt
      keep_alive: "10m",
      format: INVOICE_JSON_SCHEMA,
      options: { num_ctx: config.local.numCtx, temperature: 0 },
      messages: messages.map((m) => ({
        role: m.role,
        content: m.text,
        ...(m.images.length ? { images: m.images.map((b) => b.toString("base64")) } : {}),
      })),
    })) as { message?: { content?: unknown }; done_reason?: string; prompt_eval_count?: number };

    if (json.done_reason === "length") throw new Error("Local LLM answer was cut off: raise LOCAL_LLM_NUM_CTX");
    const content = json.message?.content;
    if (typeof content !== "string" || content.trim() === "") throw new Error("Local LLM returned an empty answer");
    return { content, promptTokens: typeof json.prompt_eval_count === "number" ? json.prompt_eval_count : null };
  }

  // ── OpenAI-compatible API (LM Studio, vLLM, llama.cpp, Ollama) ───────

  private async chatOpenAi(messages: Msg[]): Promise<Answer> {
    const json = (await this.post(`${config.local.baseUrl}/chat/completions`, {
      model: this.model,
      temperature: 0,
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { name: "standard_invoice", strict: true, schema: INVOICE_JSON_SCHEMA },
      },
      messages: messages.map((m) =>
        m.images.length
          ? {
              role: m.role,
              // Images first, then the text (what vision models such as Gemma expect).
              content: [
                ...m.images.map((b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}` } })),
                { type: "text", text: m.text },
              ],
            }
          : { role: m.role, content: m.text },
      ),
    })) as { choices?: { finish_reason?: string; message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number } };

    const choice = json.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new Error("Local LLM answer was cut off: the model's context or output limit is too small");
    }
    const content = choice?.message?.content;
    if (typeof content !== "string" || content.trim() === "") throw new Error("Local LLM returned an empty answer");
    const promptTokens = json.usage?.prompt_tokens;
    return { content, promptTokens: typeof promptTokens === "number" ? promptTokens : null };
  }

  // ── shared ────────────────────────────────────────────────────────────

  private async post(url: string, payload: unknown): Promise<unknown> {
    const { apiKey, timeoutMs, baseUrl } = config.local;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: noFetchTimeouts,
      } as RequestInit);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RetryableError(`Local LLM took longer than ${timeoutMs / 1000}s (raise LOCAL_LLM_TIMEOUT_MS)`);
      }
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new RetryableError(`Can't reach the local LLM at ${baseUrl}. Is it running? (${reason})`);
    }

    const body = await res.text();
    if (!res.ok) {
      if (res.status === 404 && /model/i.test(body)) {
        throw new Error(`The local LLM server has no model "${this.model}". Download it first (Ollama: ollama pull ${this.model})`);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`Local LLM busy (${res.status}): ${body.slice(0, 200)}`);
      }
      if (/context/i.test(body)) {
        throw new Error(`The invoice is too long for the model's context: raise LOCAL_LLM_NUM_CTX. (${body.slice(0, 200)})`);
      }
      throw new Error(`Local LLM error ${res.status}: ${body.slice(0, 300)}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`Local LLM server sent something that isn't JSON: ${body.slice(0, 200)}`);
    }
  }

  private check(answer: string): Check {
    let data: unknown;
    try {
      data = JSON.parse(stripFences(answer));
    } catch {
      return { ok: false, error: "not valid JSON" };
    }
    const parsed = InvoiceSchema.safeParse(data);
    if (parsed.success) return { ok: true, invoice: parsed.data };
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "answer"}: ${i.message}`);
    return { ok: false, error: issues.join("; ") };
  }
}
