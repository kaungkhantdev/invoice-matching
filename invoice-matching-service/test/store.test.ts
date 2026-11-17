import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// The store reads its folder from config at import time, so set it first.
const dir = await mkdtemp(join(tmpdir(), "invoice-store-test-"));
process.env.UI_STORE_DIR = dir;
const { InvoiceStore } = await import("../src/ui/invoice-store.service.js");

/** A stand-in MatchingService: reads can be held back, and the result says whether it was a duplicate. */
function fakeMatching() {
  const held = new Map<string, () => void>();
  return {
    held,
    fingerprint: (data: Buffer) => createHash("sha256").update(data).digest("hex"),
    read: async (file: string) => {
      if (file.startsWith("slow")) await new Promise<void>((resolve) => held.set(file, resolve));
      return { invoice: {}, readBy: "xml", model: null, error: null, retryable: false, seconds: 0 };
    },
    check: async (file: string, hash: string, _read: unknown, seen: { byHash: Map<string, string> }) => {
      const duplicateOf = seen.byHash.get(hash) ?? null;
      return { file, outcome: duplicateOf ? "REVIEW" : "MATCHED", duplicateOf, invoiceKey: null };
    },
    remember: (seen: { byHash: Map<string, string> }, file: string, hash: string) => {
      if (!seen.byHash.has(hash)) seen.byHash.set(hash, file);
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("invoice queue", () => {
  it("an identical later file is a duplicate at once, even while the earlier copy is still being read", async () => {
    const matching = fakeMatching();
    const store = new InvoiceStore(matching as never, { reload: async () => {} } as never);
    await store.onModuleInit();
    const same = Buffer.from("same invoice bytes");

    await store.add([{ name: "slow-copy.txt", data: same }], "local"); // waits for the AI
    await store.add([{ name: "fast-copy.xml", data: same }], "local"); // no AI, done at once
    await wait(50);

    const [first, second] = store.list();
    assert.equal(first.state, "READING");
    assert.equal(second.state, "DONE");
    assert.equal(second.result?.outcome, "REVIEW", "later identical copy must not show Matched");

    matching.held.get("slow-copy.txt")!();
    await wait(50);
    assert.equal(store.list()[0].result?.outcome, "MATCHED", "the first copy is the original");
  });

  it("the list is saved before any reading starts", async () => {
    const matching = fakeMatching();
    const store = new InvoiceStore(matching as never, { reload: async () => {} } as never);
    await store.onModuleInit();
    await store.add([{ name: "slow-saved.txt", data: Buffer.from("another invoice") }], "local");
    // No waiting: the add() call itself must already have written the list to disk.
    const saved = JSON.parse(readFileSync(join(dir, "store.json"), "utf8")) as { file: string }[];
    assert.ok(saved.some((e) => e.file === "slow-saved.txt"));
    assert.ok(existsSync(join(dir, "files")));
    matching.held.get("slow-saved.txt")?.();
  });
});
