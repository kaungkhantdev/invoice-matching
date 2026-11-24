import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { config } from "../config.js";
import type { StandardInvoice } from "../invoice.schema.js";
import { INVOICE_FORMAT, invoiceContent, invoiceFromAnswer } from "./claude-format.js";
import { InvoiceExtractor, RetryableError, SYSTEM_PROMPT } from "./extractor.js";
import type { Prepared } from "./file-prep.js";
import { noLoginAtAll } from "./network.js";

/** The one call we make, so tests can pass a fake. */
type Create = (body: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Pick<Anthropic.Beta.BetaMessage, "stop_reason" | "content">>;

/**
 * AI_PROVIDER=bedrock (default) — Claude on Amazon Bedrock, the production setup.
 *
 * Signs in with the normal AWS login (AWS CLI profile, SSO, or the Lambda/Fargate role): no API key.
 * Calls bedrock-runtime in BEDROCK_REGION (Singapore). Claude Sonnet 5 runs In-Region there, so invoices stay
 * in Singapore. Same request as the Claude API (same prompt, same JSON structure), minus server-side
 * fallbacks, which Bedrock doesn't offer: a refused file simply goes to review.
 */
export class BedrockExtractor extends InvoiceExtractor {
  readonly provider = "bedrock" as const;
  readonly model = config.bedrock.model;
  private create: Create | null;

  constructor(create?: Create) {
    super();
    this.create = create ?? null;
  }

  private getCreate(): Create {
    if (!this.create) {
      // apiKey: null = sign with the AWS login, even if an AWS_BEARER_TOKEN_BEDROCK happens to be set.
      const client = new AnthropicBedrock({ awsRegion: config.bedrock.region, apiKey: null, maxRetries: 4 });
      this.create = (body) => client.beta.messages.create(body);
    }
    return this.create;
  }

  async extract(fileName: string, prepared: Prepared, ocr?: string | null): Promise<StandardInvoice> {
    let response;
    try {
      response = await this.getCreate()({
        model: this.model,
        max_tokens: 16000,
        output_config: { effort: config.bedrock.effort, format: INVOICE_FORMAT },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: invoiceContent(fileName, prepared, ocr) }],
      });
    } catch (error) {
      throw explainBedrockError(error, this.model);
    }
    return invoiceFromAnswer(response);
  }
}

/** Bedrock errors in plain words. Temporary ones become RetryableError, so the queue tries again later. */
export function explainBedrockError(error: unknown, model: string): Error {
  const where = `Bedrock (${config.bedrock.region})`;
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  if (error instanceof Anthropic.APIConnectionError && /resolve AWS credentials/i.test(message)) {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause ?? "");
    // Tried again either way: the same words come from a login helper or SSO refresh that is only offline.
    if (noLoginAtAll(cause)) {
      return new RetryableError(`No AWS login found on this machine for ${where}: run "aws configure" or "aws sso login" (or set AWS_PROFILE) (${cause})`);
    }
    return new RetryableError(`${where}: couldn't get the AWS login (network down, or the SSO session ended: run "aws sso login"): ${cause}`);
  }
  if (error instanceof Anthropic.RateLimitError) return new RetryableError(`${where} is busy (quota reached): ${message}`);
  // 5xx, 408 (ModelTimeoutException), 424 (ModelErrorException), network: temporary.
  if (
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError ||
    error instanceof Anthropic.RequestTimeoutError ||
    status === 424
  ) {
    return new RetryableError(`${where} busy, timed out or unreachable: ${message}`);
  }
  // AWS answers an expired or wrong login with 403 too, so look at the words before blaming permissions.
  if (error instanceof Anthropic.AuthenticationError || (error instanceof Anthropic.PermissionDeniedError && /security token|expired|signature/i.test(message))) {
    return new Error(`${where} rejected the AWS login (expired? run "aws sso login"): ${message}`);
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new Error(`${where}: this AWS login may not use ${model} (needs bedrock:InvokeModel, and model access in the Bedrock console): ${message}`);
  }
  if (
    error instanceof Anthropic.NotFoundError ||
    (error instanceof Anthropic.BadRequestError && /inference profile|on-demand throughput|model identifier|model id\b/i.test(message))
  ) {
    return new Error(`${where} doesn't offer "${model}" this way (check BEDROCK_MODEL and BEDROCK_REGION): ${message}`);
  }
  if (error instanceof Anthropic.APIError) return new Error(`${where} error ${status ?? ""}: ${message}`);
  return error instanceof Error ? error : new Error(message);
}
