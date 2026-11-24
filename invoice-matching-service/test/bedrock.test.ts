import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import type { StandardInvoice } from "../src/invoice-matching/invoice.schema.js";
import { BedrockExtractor } from "../src/invoice-matching/reader/bedrock.extractor.js";
import { RetryableError } from "../src/invoice-matching/reader/extractor.js";
import { awsLoginFound } from "../src/invoice-matching/reader/extractor.registry.js";

const good: StandardInvoice = {
  documentType: "invoice",
  supplier: { name: "Tiong Bahru Ribbon & Craft", uen: "53312345A", gstRegNo: null, address: null },
  bank: { accountHolder: null, accountNumber: "351-301-234-5", swift: null },
  invoiceNumber: "TBR-0457",
  invoiceDate: "2026-11-06",
  dueDate: null,
  poNumber: "PO-2026-0103",
  currency: "SGD",
  pricesIncludeTax: false,
  lines: [{ description: "Satin ribbon 25mm roll", quantity: "40", unitPrice: "6.50", amount: "260.00" }],
  subtotal: "260.00",
  tax: "0",
  fees: "0",
  discounts: "0",
  total: "260.00",
  uncertainFields: [], billTo: "Industrial & Commercial Facilities Management Pte Ltd", site: null, servicePeriod: null, serviceRecords: [], otherInvoicesInFile: [],
};

const image = { kind: "image" as const, mediaType: "image/jpeg" as const, data: Buffer.from("fake-jpeg") };
const answer = (text: string, stop_reason: Anthropic.Beta.BetaStopReason = "end_turn") => async () =>
  ({ stop_reason, content: [{ type: "text", text, citations: null }] }) as Pick<Anthropic.Beta.BetaMessage, "stop_reason" | "content">;
const failWith = (error: unknown) => async () => {
  throw error;
};

describe("BedrockExtractor", () => {
  it("sends the file, Textract's text and our JSON structure to Claude Sonnet 5 in Singapore", async () => {
    const bodies: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const ai = new BedrockExtractor(async (body) => {
      bodies.push(body);
      return answer(JSON.stringify(good))();
    });
    assert.deepEqual(await ai.extract("photo.jpg", image, "TAX INVOICE TBR-0457"), good);

    const body = bodies[0];
    assert.equal(body.model, "anthropic.claude-sonnet-5", "In-Region model ID: the invoice stays in Singapore");
    assert.equal(body.output_config?.format?.type, "json_schema");
    assert.equal(body.output_config?.effort, "medium");
    assert.equal("fallbacks" in body, false, "Bedrock has no server-side fallbacks");
    const content = body.messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    assert.equal(content[0].type, "image");
    const text = content.at(-1);
    assert.ok(text?.type === "text" && text.text.includes('<ocr source="Amazon Textract">\nTAX INVOICE TBR-0457\n</ocr>'));
  });

  it("sends a PDF as a document, and no OCR block when there is no Textract text", async () => {
    const bodies: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    await new BedrockExtractor(async (body) => {
      bodies.push(body);
      return answer(JSON.stringify(good))();
    }).extract("inv.pdf", { kind: "pdf", data: Buffer.from("%PDF") }, null);
    const content = bodies[0].messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
    assert.equal(content[0].type, "document");
    assert.ok(content.every((b) => b.type !== "text" || !b.text.includes("<ocr")));
  });

  it("an answer that doesn't fit our structure → a plain error", async () => {
    await assert.rejects(new BedrockExtractor(answer('{"total": 5}')).extract("a.jpg", image), /didn't fit our invoice structure/);
    await assert.rejects(new BedrockExtractor(answer("", "refusal")).extract("a.jpg", image), /declined/);
  });

  it("no AWS login found → tried again (a login helper may only be offline), and says how to log in", async () => {
    const e = new Anthropic.APIConnectionError({
      message: "Failed to resolve AWS credentials from the credential provider chain.",
      cause: new Error("Could not load credentials from any providers"),
    });
    await assert.rejects(
      new BedrockExtractor(failWith(e)).extract("a.jpg", image),
      (err: Error) => err instanceof RetryableError && /No AWS login found.*aws configure/.test(err.message),
    );
  });

  it("an SSO login refresh failing because the network is down → RetryableError, not 'no login'", async () => {
    const e = new Anthropic.APIConnectionError({
      message: "Failed to resolve AWS credentials from the credential provider chain.",
      cause: new Error("getaddrinfo ENOTFOUND portal.sso.ap-southeast-1.amazonaws.com"),
    });
    await assert.rejects(new BedrockExtractor(failWith(e)).extract("a.jpg", image), RetryableError);
    // The real SSO provider (fetch-based) says only "TypeError: fetch failed": still tried again.
    const fetchFailed = new Anthropic.APIConnectionError({
      message: "Failed to resolve AWS credentials from the credential provider chain.",
      cause: new Error("TypeError: fetch failed"),
    });
    await assert.rejects(new BedrockExtractor(failWith(fetchFailed)).extract("a.jpg", image), RetryableError);
  });

  it("quota reached or Bedrock unreachable → RetryableError: the queue tries again later", async () => {
    const throttled = new Anthropic.RateLimitError(429, { message: "Too many requests" }, "Too many requests", new Headers());
    await assert.rejects(new BedrockExtractor(failWith(throttled)).extract("a.jpg", image), RetryableError);
    const down = new Anthropic.APIConnectionError({ message: "Connection error." });
    await assert.rejects(new BedrockExtractor(failWith(down)).extract("a.jpg", image), RetryableError);
  });

  it("Bedrock timed out (408) or the model failed (424) → RetryableError", async () => {
    const timeout = new Anthropic.RequestTimeoutError(408, { message: "Model has timed out" }, "Model has timed out", new Headers());
    await assert.rejects(new BedrockExtractor(failWith(timeout)).extract("a.jpg", image), RetryableError);
    const modelError = new Anthropic.APIError(424, { message: "ModelErrorException" }, "ModelErrorException", new Headers());
    await assert.rejects(new BedrockExtractor(failWith(modelError)).extract("a.jpg", image), RetryableError);
  });

  it("an expired login (403 'security token … expired') says to log in again, not to add permissions", async () => {
    const expired = new Anthropic.PermissionDeniedError(403, { message: "The security token included in the request is expired" }, "The security token included in the request is expired", new Headers());
    await assert.rejects(new BedrockExtractor(failWith(expired)).extract("a.jpg", image), /rejected the AWS login.*aws sso login/);
  });

  it("'input too long' is not reported as a wrong model", async () => {
    const tooLong = new Anthropic.BadRequestError(400, { message: "Input is too long for requested model." }, "Input is too long for requested model.", new Headers());
    await assert.rejects(new BedrockExtractor(failWith(tooLong)).extract("a.jpg", image), (e: Error) => !/doesn't offer/.test(e.message) && /Input is too long/.test(e.message));
  });

  it("no access to the model → says which permission is missing", async () => {
    const denied = new Anthropic.PermissionDeniedError(403, { message: "You don't have access to the model" }, "You don't have access to the model", new Headers());
    await assert.rejects(new BedrockExtractor(failWith(denied)).extract("a.jpg", image), /bedrock:InvokeModel/);
  });
});

describe("AWS login check (for the status hint)", () => {
  it("finds a login from the environment or ~/.aws, and none in an empty home", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "no-aws-"));
    assert.equal(awsLoginFound({}, emptyHome), false);
    assert.equal(awsLoginFound({ AWS_PROFILE: "finance" }, emptyHome), true);
    assert.equal(awsLoginFound({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials" }, emptyHome), true);
  });
});
