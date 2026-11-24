import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { InvoiceSchema, type StandardInvoice } from "../invoice.schema.js";
import { instructionWithOcr } from "./extractor.js";
import type { Prepared } from "./file-prep.js";

/**
 * What the Claude API and Claude on Bedrock share: the same request content and the same answer handling.
 * Only the client (API key vs AWS login) and the model name differ.
 */

/** Our standard invoice as the JSON schema Claude must answer in (converted by the SDK's helper). */
export const INVOICE_FORMAT = { type: "json_schema" as const, schema: betaZodOutputFormat(InvoiceSchema).schema };

/** The file (PDF, image or text), then Textract's text and the instruction. */
export function invoiceContent(fileName: string, prepared: Prepared, ocr: string | null | undefined): Anthropic.Beta.BetaContentBlockParam[] {
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
  content.push({ type: "text", text: instructionWithOcr(ocr) });
  return content;
}

/** Claude's answer → our standard invoice, or a plain-words error. */
export function invoiceFromAnswer(response: Pick<Anthropic.Beta.BetaMessage, "stop_reason" | "content">): StandardInvoice {
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
