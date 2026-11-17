import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { config } from "../config.js";
import { InvoiceSchema, type StandardInvoice } from "../invoice.schema.js";
import { InvoiceExtractor, RetryableError, SYSTEM_PROMPT, USER_INSTRUCTION } from "./extractor.js";
import type { Prepared } from "./file-prep.js";

/** Our standard invoice as the JSON schema Claude must answer in (converted by the SDK's helper). */
const INVOICE_FORMAT = { type: "json_schema" as const, schema: betaZodOutputFormat(InvoiceSchema).schema };

/**
 * AI_PROVIDER=claude — reads invoices with the Claude API (needs ANTHROPIC_API_KEY).
 * Accepts PDFs directly, so no PDF conversion is needed.
 */
export class ClaudeExtractor extends InvoiceExtractor {
  readonly provider = "claude" as const;
  readonly model = config.claude.model;
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    // The SDK already retries a few times with backoff; the queue retries again later on top of that.
    this.client ??= new Anthropic({ maxRetries: 4 });
    return this.client;
  }

  async extract(fileName: string, prepared: Prepared): Promise<StandardInvoice> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (prepared.kind === "pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: prepared.data.toString("base64") },
      });
    } else if (prepared.kind === "image") {
      content.push({
        type: "image",
        source: { type: "base64", media_type: prepared.mediaType, data: prepared.data.toString("base64") },
      });
    } else {
      content.push({ type: "text", text: `<file name="${fileName}">\n${prepared.text}\n</file>` });
    }
    content.push({ type: "text", text: USER_INSTRUCTION });

    let response;
    try {
      // create() (not parse()): parse() throws on a bad answer before we can see why it stopped.
      response = await this.getClient().beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        // If the model declines, the API retries on a fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01", "structured-outputs-2025-12-15"],
        fallbacks: "default",
        output_config: { effort: config.claude.effort, format: INVOICE_FORMAT },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new Error("Anthropic API key missing or invalid: set ANTHROPIC_API_KEY in .env (or use AI_PROVIDER=local)");
      }
      if (
        error instanceof Anthropic.RateLimitError ||
        error instanceof Anthropic.InternalServerError ||
        error instanceof Anthropic.APIConnectionError
      ) {
        throw new RetryableError(`Claude API busy or unreachable: ${error.message}`);
      }
      if (error instanceof Anthropic.APIError) {
        throw new Error(`Claude API error ${error.status ?? ""}: ${error.message}`);
      }
      if (error instanceof Error && /api.?key|credential|auth/i.test(error.message)) {
        throw new Error("Anthropic API key missing: set ANTHROPIC_API_KEY in .env (or use AI_PROVIDER=local)");
      }
      throw error;
    }

    if (response.stop_reason === "refusal") throw new Error("AI declined to read this file");
    if (response.stop_reason === "max_tokens") throw new Error("AI answer was cut off (too long)");
    // The answer is the last text block (after a fallback there can be more than one).
    const text = response.content.findLast((b) => b.type === "text")?.text;
    if (!text) throw new Error("AI gave no answer");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("AI answer wasn't valid JSON");
    }
    const parsed = InvoiceSchema.safeParse(data);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`AI answer didn't fit our invoice structure (${issues.join("; ")})`);
    }
    return parsed.data;
  }
}
