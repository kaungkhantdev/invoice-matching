import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pricesIncludeTaxFromNumbers } from "../src/invoice-matching/normalize.js";
import { LocalLlmExtractor } from "../src/invoice-matching/reader/local-llm.extractor.js";
import type { StandardInvoice } from "../src/invoice-matching/invoice.schema.js";

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
  uncertainFields: [],
};

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

/** A fake OpenAI-compatible server: returns the given answers in order and records each request. */
function fakeServer(answers: (string | { status: number; body: string })[]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const next = answers[calls.length - 1];
    if (typeof next === "object") return new Response(next.body, { status: next.status });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: next } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const image = { kind: "image" as const, mediaType: "image/jpeg" as const, data: Buffer.from("fake-jpeg") };

describe("LocalLlmExtractor", () => {
  it("sends an OpenAI-compatible request with the image and our JSON schema", async () => {
    const { calls, fetchFn } = fakeServer([JSON.stringify(good)]);
    const invoice = await new LocalLlmExtractor(fetchFn, "openai").extract("photo.jpg", image);

    assert.deepEqual(invoice, good);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/chat\/completions$/);
    const body = calls[0].body as {
      model: string;
      temperature: number;
      response_format: { type: string; json_schema: { schema: { properties: Record<string, unknown> } } };
      messages: { role: string; content: { type: string; image_url?: { url: string } }[] }[];
    };
    assert.equal(body.temperature, 0);
    assert.equal(body.response_format.type, "json_schema");
    assert.ok("invoiceNumber" in body.response_format.json_schema.schema.properties);
    const user = body.messages.find((m) => m.role === "user")!;
    assert.ok(user.content.some((p) => p.type === "image_url" && p.image_url!.url.startsWith("data:image/jpeg;base64,")));
  });

  it("accepts JSON wrapped in ``` fences", async () => {
    const { fetchFn } = fakeServer(["```json\n" + JSON.stringify(good) + "\n```"]);
    assert.deepEqual(await new LocalLlmExtractor(fetchFn, "openai").extract("a.jpg", image), good);
  });

  it("retries once when the answer doesn't fit, telling the model what was wrong", async () => {
    const broken = JSON.stringify({ ...good, lines: "none" });
    const { calls, fetchFn } = fakeServer([broken, JSON.stringify(good)]);
    assert.deepEqual(await new LocalLlmExtractor(fetchFn, "openai").extract("a.jpg", image), good);
    assert.equal(calls.length, 2);
    const retry = calls[1].body as { messages: { role: string; content: unknown }[] };
    assert.match(String(retry.messages.at(-1)!.content), /lines/);
  });

  it("gives up after the second bad answer", async () => {
    const { fetchFn } = fakeServer(["not json", "still not json"]);
    await assert.rejects(new LocalLlmExtractor(fetchFn, "openai").extract("a.jpg", image), /didn't fit/);
  });

  it("explains a missing model", async () => {
    const { fetchFn } = fakeServer([{ status: 404, body: '{"error":"model \\"gemma4:12b\\" not found"}' }]);
    await assert.rejects(new LocalLlmExtractor(fetchFn, "openai").extract("a.jpg", image), /ollama pull/);
  });

  it("explains when the server isn't running", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:11434") });
    }) as unknown as typeof fetch;
    await assert.rejects(new LocalLlmExtractor(fetchFn, "openai").extract("a.jpg", image), /Is it running\?.*ECONNREFUSED/);
  });

  it("sends spreadsheet text as text", async () => {
    const { calls, fetchFn } = fakeServer([JSON.stringify(good)]);
    await new LocalLlmExtractor(fetchFn, "openai").extract("inv.xlsx", { kind: "text", text: "A1: INVOICE" });
    const user = (calls[0].body as { messages: { role: string; content: unknown }[] }).messages[1];
    assert.equal(typeof user.content, "string");
    assert.ok(String(user.content).includes("A1: INVOICE"));
  });
});

describe("LocalLlmExtractor with Ollama's own API", () => {
  /** A fake Ollama /api/chat server. */
  function fakeOllama(answers: unknown[]) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const next = answers[calls.length - 1];
      if (next instanceof Response) return next;
      return new Response(JSON.stringify(next), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }
  const ok = (content: string, promptTokens = 900) => ({ message: { content }, done_reason: "stop", prompt_eval_count: promptTokens });

  it("turns thinking off, sets the context, asks for an error instead of cutting, and sends plain base64 images", async () => {
    const { calls, fetchFn } = fakeOllama([ok(JSON.stringify(good))]);
    assert.deepEqual(await new LocalLlmExtractor(fetchFn, "ollama").extract("photo.jpg", image), good);
    assert.match(calls[0].url, /:11434\/api\/chat$/);
    const body = calls[0].body as {
      think: boolean;
      truncate: boolean;
      stream: boolean;
      format: { properties: Record<string, unknown> };
      options: { num_ctx: number; temperature: number };
      messages: { role: string; content: string; images?: string[] }[];
    };
    assert.equal(body.think, false);
    assert.equal(body.truncate, false);
    assert.equal(body.stream, false);
    assert.ok(body.options.num_ctx >= 8192);
    assert.equal(body.options.temperature, 0);
    assert.ok("invoiceNumber" in body.format.properties);
    const user = body.messages.find((m) => m.role === "user")!;
    assert.deepEqual(user.images, [Buffer.from("fake-jpeg").toString("base64")]);
  });

  it("explains a too-long invoice", async () => {
    const tooLong = new Response('{"error":"request (9843 tokens) exceeds the available context size (8192 tokens)"}', { status: 400 });
    const { fetchFn } = fakeOllama([tooLong]);
    await assert.rejects(new LocalLlmExtractor(fetchFn, "ollama").extract("a.jpg", image), /LOCAL_LLM_NUM_CTX/);
  });

  it("stops when far fewer tokens were read than the text sent (silently cut prompt)", async () => {
    const bigText = "Line item ".repeat(4000);
    const { fetchFn } = fakeOllama([ok(JSON.stringify(good), 2048)]);
    await assert.rejects(
      new LocalLlmExtractor(fetchFn, "ollama").extract("big.xlsx", { kind: "text", text: bigText }),
      /context is too small/,
    );
  });
});

describe("pricesIncludeTaxFromNumbers", () => {
  it("GST added on top → false, even if the reader said true", () => {
    assert.equal(pricesIncludeTaxFromNumbers(true, "384.00", "34.56", "0", "0", "418.56"), false);
  });
  it("GST included in the prices → true, even if the reader said false", () => {
    assert.equal(pricesIncludeTaxFromNumbers(false, "1188.10", "98.10", "0", "0", "1188.10"), true);
  });
  it("no GST → false", () => {
    assert.equal(pricesIncludeTaxFromNumbers(true, "260.00", "0", "0", "0", "260.00"), false);
  });
  it("numbers don't add up either way → keep what the reader said", () => {
    assert.equal(pricesIncludeTaxFromNumbers(true, "100.00", "9.00", "0", "0", "150.00"), true);
  });
});
