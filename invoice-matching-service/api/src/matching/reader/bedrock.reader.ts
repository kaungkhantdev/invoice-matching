import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config } from "../../config.js";
import { InvoiceSchema, type StandardInvoice } from "../invoice.schema.js";
import { PoSchema, type PoRead } from "../po.schema.js";
import { noLoginAtAll, RetryableError } from "./errors.js";
import type { Prepared } from "./file-prep.js";
import { instructionWithOcr, PO_INSTRUCTION, PO_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompt.js";

/** The part of Claude's answer we use. */
type Answer = Pick<Anthropic.Beta.BetaMessage, "stop_reason" | "content">;

/** The one call we make, so tests can pass a fake. */
type Create = (body: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Answer>;

type Content = Anthropic.Beta.BetaContentBlockParam[];

/** Our standard invoice, and the PO, as the JSON schemas Claude must answer in (converted by the SDK's helper). */
const INVOICE_FORMAT = { type: "json_schema" as const, schema: betaZodOutputFormat(InvoiceSchema).schema };
const PO_FORMAT = { type: "json_schema" as const, schema: betaZodOutputFormat(PoSchema).schema };

/** The longest answer we take from Claude: a longer one is cut off and the invoice goes to review. */
const MAX_ANSWER_TOKENS = 16000;

/** Schema problems shown in the error when Claude's answer doesn't fit. */
const MAX_ISSUES_SHOWN = 3;

/**
 * Claude on Amazon Bedrock: the file (PDF, image or spreadsheet text) and Textract's text in, our standard invoice out.
 *
 * Signs in with the AWS login (keys in .env, an AWS profile, or the Lambda/Fargate role). Calls bedrock-runtime in
 * BEDROCK_REGION (Singapore), where Claude Sonnet 5 runs In-Region, so invoices stay in Singapore.
 * Bedrock has no server-side fallback: a refused file simply goes to review.
 */
export class BedrockReader {
  readonly model = config.bedrock.model;
  private create: Create | null;

  constructor(create?: Create) {
    this.create = create ?? null;
  }

  /** One file into our standard invoice. `ocr`: Textract's text of the same file, if it has any. */
  async read(fileName: string, prepared: Prepared, ocr: string | null): Promise<StandardInvoice> {
    const content = [fileBlock(fileName, prepared), { type: "text" as const, text: instructionWithOcr(ocr) }];
    return invoiceFromAnswer(await this.ask(SYSTEM_PROMPT, INVOICE_FORMAT, content));
  }

  /** Screenshots (or a printout) of one PO page from our system, in one call: the PO as shown. */
  async readPo(files: { name: string; prepared: Prepared }[]): Promise<PoRead> {
    const content = [
      ...files.map((file) => fileBlock(file.name, file.prepared)),
      { type: "text" as const, text: PO_INSTRUCTION },
    ];
    return answerAs(await this.ask(PO_SYSTEM_PROMPT, PO_FORMAT, content), PoSchema, "our PO structure");
  }

  /** One Bedrock call; its errors in plain words. */
  private async ask(system: string, format: typeof INVOICE_FORMAT, content: Content): Promise<Answer> {
    try {
      return await this.getCreate()({
        model: this.model,
        max_tokens: MAX_ANSWER_TOKENS,
        output_config: { effort: config.bedrock.effort, format },
        system,
        messages: [{ role: "user", content }],
      });
    } catch (error) {
      throw explainBedrockError(error, this.model);
    }
  }

  /** The real Bedrock call, made on first use (unless a test passed one in). */
  private getCreate(): Create {
    if (this.create) return this.create;
    // apiKey: null = sign with the AWS login, even if an AWS_BEARER_TOKEN_BEDROCK happens to be set.
    const client = new AnthropicBedrock({ awsRegion: config.bedrock.region, apiKey: null, maxRetries: 4 });
    this.create = (body) => client.beta.messages.create(body);
    return this.create;
  }
}

/** The file as Claude takes it: a PDF document, an image, or text inside a <file> tag. */
function fileBlock(fileName: string, prepared: Prepared): Anthropic.Beta.BetaContentBlockParam {
  if (prepared.kind === "pdf") {
    const data = prepared.data.toString("base64");
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
  }
  if (prepared.kind === "image") {
    const data = prepared.data.toString("base64");
    return { type: "image", source: { type: "base64", media_type: prepared.mediaType, data } };
  }
  return { type: "text", text: `<file name="${fileName}">\n${prepared.text}\n</file>` };
}

/** Claude's answer → our standard invoice, or a plain-words error. */
export function invoiceFromAnswer(response: Answer): StandardInvoice {
  return answerAs(response, InvoiceSchema, "our invoice structure");
}

/** Claude's answer → the structure it was asked for (`structure` names it in the error), or a plain-words error. */
function answerAs<T>(response: Answer, schema: z.ZodType<T>, structure: string): T {
  if (response.stop_reason === "refusal") throw new Error("AI declined to read this file");
  if (response.stop_reason === "max_tokens") throw new Error("AI answer was cut off (too long)");
  const text = response.content.findLast((block) => block.type === "text")?.text;
  if (!text) throw new Error("AI gave no answer");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("AI answer wasn't valid JSON");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, MAX_ISSUES_SHOWN)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`AI answer didn't fit ${structure} (${issues.join("; ")})`);
  }
  return parsed.data;
}

/** Bedrock errors in plain words. Temporary ones become RetryableError, so the queue tries again later. */
export function explainBedrockError(error: unknown, model: string): Error {
  const where = `Bedrock (${config.bedrock.region})`;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Anthropic.APIConnectionError && /resolve AWS credentials/i.test(message)) {
    return loginProblem(error.cause, where);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new RetryableError(`${where} is busy (quota reached): ${message}`);
  }
  if (isTemporary(error)) return new RetryableError(`${where} busy, timed out or unreachable: ${message}`);
  if (isLoginRejected(error, message)) {
    return new Error(`${where} rejected the AWS login (wrong or expired keys?): ${message}`);
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new Error(
      `${where}: this AWS login may not use ${model} ` +
        `(needs bedrock:InvokeModel, and model access in the Bedrock console): ${message}`,
    );
  }
  if (isModelNotOffered(error, message)) {
    return new Error(`${where} doesn't offer "${model}" this way (check BEDROCK_MODEL and BEDROCK_REGION): ${message}`);
  }
  if (error instanceof Anthropic.APIError) return new Error(`${where} error ${error.status ?? ""}: ${message}`);
  return error instanceof Error ? error : new Error(message);
}

/** The SDK couldn't get an AWS login (`cause` says why): none set up here, or the network or SSO session is down. */
function loginProblem(cause: unknown, where: string): RetryableError {
  const reason = cause instanceof Error ? cause.message : String(cause ?? "");
  // Tried again either way: the same words come from a login helper or SSO refresh that is only offline.
  if (noLoginAtAll(reason)) {
    return new RetryableError(
      `No AWS login found on this machine for ${where}: set the AWS keys in .env, or AWS_PROFILE (${reason})`,
    );
  }
  return new RetryableError(`${where}: couldn't get the AWS login (network down, or the SSO session ended): ${reason}`);
}

/** 5xx, 408 (ModelTimeoutException), 424 (ModelErrorException), network: temporary. */
function isTemporary(error: unknown): boolean {
  return (
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError ||
    error instanceof Anthropic.RequestTimeoutError ||
    (error instanceof Anthropic.APIError && error.status === 424)
  );
}

/** AWS answers an expired or wrong login with 403 too, so look at the words before blaming permissions. */
function isLoginRejected(error: unknown, message: string): boolean {
  const loginWords = /security token|expired|signature/i.test(message);
  const deniedForLogin = error instanceof Anthropic.PermissionDeniedError && loginWords;
  return error instanceof Anthropic.AuthenticationError || deniedForLogin;
}

/** A model ID Bedrock doesn't know, or doesn't offer on demand in this region (e.g. only via an inference profile). */
function isModelNotOffered(error: unknown, message: string): boolean {
  const modelWords = /inference profile|on-demand throughput|model identifier|model id\b/i.test(message);
  return error instanceof Anthropic.NotFoundError || (error instanceof Anthropic.BadRequestError && modelWords);
}
