import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { StandardInvoice } from "../invoice.schema.js";
import { INVOICE_FORMAT, invoiceContent, invoiceFromAnswer } from "./claude-format.js";
import { InvoiceExtractor, RetryableError, SYSTEM_PROMPT } from "./extractor.js";
import type { Prepared } from "./file-prep.js";

/**
 * AI_PROVIDER=claude — reads invoices with the Claude API directly (needs ANTHROPIC_API_KEY).
 * Handy for trying the app without AWS. Production uses Claude on Amazon Bedrock (AI_PROVIDER=bedrock).
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

  async extract(fileName: string, prepared: Prepared, ocr?: string | null): Promise<StandardInvoice> {
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
        messages: [{ role: "user", content: invoiceContent(fileName, prepared, ocr) }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new Error("Anthropic API key missing or invalid: set ANTHROPIC_API_KEY in .env (or use AI_PROVIDER=bedrock)");
      }
      if (
        error instanceof Anthropic.RateLimitError ||
        error instanceof Anthropic.InternalServerError ||
        error instanceof Anthropic.APIConnectionError ||
        error instanceof Anthropic.RequestTimeoutError
      ) {
        throw new RetryableError(`Claude API busy or unreachable: ${error.message}`);
      }
      if (error instanceof Anthropic.APIError) {
        throw new Error(`Claude API error ${error.status ?? ""}: ${error.message}`);
      }
      if (error instanceof Error && /api.?key|credential|auth/i.test(error.message)) {
        throw new Error("Anthropic API key missing: set ANTHROPIC_API_KEY in .env (or use AI_PROVIDER=bedrock)");
      }
      throw error;
    }
    return invoiceFromAnswer(response);
  }
}
