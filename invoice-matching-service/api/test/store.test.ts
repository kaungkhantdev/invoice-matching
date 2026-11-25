import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// Each test gives the store a folder of its own (freshStore), so nothing here touches output/.
process.env.UI_STORE_DIR = await mkdtemp(join(tmpdir(), "invoice-store-test-"));
const { InvoiceStore } = await import("../src/invoices/invoice-store.service.js");
const { config } = await import("../src/config.js");

/** A stand-in MatchingService: reads can be held back, and the result says whether it was a duplicate. */
function fakeMatching() {
  const held = new Map<string, () => void>();
  return {
    held,
    fingerprint: (data: Buffer) => createHash("sha256").update(data).digest("hex"),
    claims: () => ({ invoiceKey: null, poKey: null }),
    readPo: async () => ({ po: { poNumber: "GEN000073" }, model: "m", seconds: 1, retryable: false, error: null }),
    read: async (file: string) => {
      if (file.startsWith("slow")) await new Promise<void>((resolve) => held.set(file, resolve));
      return { invoice: {}, readBy: "bedrock", model: null, error: null, retryable: false, seconds: 0 };
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

/** A store in a folder of its own, so the invoices of other tests aren't loaded and read again. */
async function freshStore(matching: unknown) {
  config.uiStoreDir = await mkdtemp(join(tmpdir(), "invoice-store-test-"));
  const store = new InvoiceStore(matching as never, { reload: async () => {} } as never);
  await store.onModuleInit();
  return store;
}

/** Adds one supplier invoice with a PO screenshot: the only way in. */
const addPair = (store: InstanceType<typeof InvoiceStore>, invoice: string, data: Buffer) =>
  store.addWithPo([{ name: `${invoice}-po.png`, data: Buffer.from(`po of ${invoice}`) }], [{ name: invoice, data }]);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("invoice queue", () => {
  it("an identical later invoice is a duplicate at once, even while the earlier copy is still being read", async () => {
    const matching = fakeMatching();
    const store = await freshStore(matching);
    const same = Buffer.from("same invoice bytes");

    await addPair(store, "slow-copy.pdf", same); // waits for the AI
    await addPair(store, "fast-copy.pdf", same);
    await wait(50);

    const [first, second] = store.list();
    assert.equal(first.state, "READING");
    assert.equal(second.state, "DONE");
    assert.equal(second.result?.outcome, "REVIEW", "later identical copy must not show Matched");

    matching.held.get("slow-copy.pdf")!();
    await wait(50);
    assert.equal(store.list()[0].result?.outcome, "MATCHED", "the first copy is the original");
  });

  it("a decision is refused when the result changed since the page showed it; an approval reaches later re-checks", async () => {
    const matching = fakeMatching();
    const calls: [string, unknown][] = [];
    const spy = {
      ...matching,
      check: (file: string, hash: string, read: unknown, seen: { byHash: Map<string, string> }, approved?: boolean) => {
        calls.push([file, approved]);
        return matching.check(file, hash, read, seen);
      },
    };
    const store = await freshStore(spy);
    await addPair(store, "decide-me.pdf", Buffer.from("an invoice to decide"));
    await wait(50);
    const entry = store.list().find((e) => e.file === "decide-me.pdf")!;
    assert.equal(entry.result?.outcome, "MATCHED");
    assert.throws(() => store.decide(entry.id, "APPROVED", "", "REVIEW"), /result changed/);
    store.decide(entry.id, "APPROVED", "ok to pay", "MATCHED");
    calls.length = 0;
    await store.recheckAll();
    assert.deepEqual(calls.find(([file]) => file === "decide-me.pdf"), ["decide-me.pdf", true]);
    assert.equal(entry.decision?.note, "ok to pay");
  });

  it("the list is saved before any reading starts", async () => {
    const matching = fakeMatching();
    const store = await freshStore(matching);
    await addPair(store, "slow-saved.pdf", Buffer.from("another invoice"));
    // No waiting: the addWithPo() call itself must already have written the list to disk.
    const saved = JSON.parse(readFileSync(join(config.uiStoreDir, "store.json"), "utf8")) as { file: string }[];
    assert.ok(saved.some((e) => e.file === "slow-saved.pdf"));
    assert.ok(existsSync(join(config.uiStoreDir, "files")));
    matching.held.get("slow-saved.pdf")?.();
  });
});

describe("an invoice uploaded with its PO", () => {
  /** A stand-in MatchingService that records the order of the reads and what each check got as the PO. */
  function pairMatching(poAnswers: { retryable: boolean; error: string | null }[] = []) {
    const base = fakeMatching();
    const steps: string[] = [];
    const checkedWith: unknown[] = [];
    return {
      ...base,
      steps,
      checkedWith,
      readPo: async (files: { name: string; data: Buffer }[]) => {
        steps.push(`po:${files.map((file) => file.name).join("+")}`);
        const answer = poAnswers.shift() ?? { retryable: false, error: null };
        return { po: answer.error ? null : { poNumber: "GEN000073" }, model: "m", seconds: 1, ...answer };
      },
      read: async (file: string) => {
        steps.push(`invoice:${file}`);
        return base.read(file);
      },
      check: async (file: string, hash: string, read: unknown, seen: { byHash: Map<string, string> }, _a?: boolean, po?: unknown) => {
        checkedWith.push(po);
        return base.check(file, hash, read, seen);
      },
    };
  }

  it("keeps the PO files, reads the PO first, then checks the invoice against it; Read again reads both", async () => {
    const matching = pairMatching();
    const store = await freshStore(matching);
    const entry = await store.addWithPo(
      [
        { name: "top.webp", data: Buffer.from("po screenshot 1") },
        { name: "items.png", data: Buffer.from("po screenshot 2") },
      ],
      [{ name: "rentokil.pdf", data: Buffer.from("the supplier invoice") }],
    );
    await wait(50);
    assert.deepEqual(matching.steps, ["po:top.webp+items.png", "invoice:rentokil.pdf"]);
    assert.equal(entry.state, "DONE");
    assert.deepEqual(entry.po?.files.map((file) => file.file), ["top.webp", "items.png"]);
    assert.deepEqual(store.poFilePaths(entry).map((path) => readFileSync(path, "utf8")), ["po screenshot 1", "po screenshot 2"]);
    assert.equal((matching.checkedWith.at(-1) as { po: { poNumber: string } }).po.poNumber, "GEN000073");

    matching.steps.length = 0;
    store.reread(entry.id);
    await wait(50);
    assert.deepEqual(matching.steps, ["po:top.webp+items.png", "invoice:rentokil.pdf"]);
  });

  it("a busy Bedrock while reading the PO → tried again later, and the invoice isn't read before the PO", async () => {
    const matching = pairMatching([{ retryable: true, error: "Bedrock busy" }]);
    const store = await freshStore(matching);
    const entry = await store.addWithPo([{ name: "po.png", data: Buffer.from("po busy") }], [{ name: "inv.pdf", data: Buffer.from("inv busy") }]);
    await wait(50);
    assert.deepEqual(matching.steps, ["po:po.png"]);
    assert.equal(entry.state, "QUEUED");
    assert.equal(entry.retryError, "Bedrock busy");
    assert.equal(entry.po?.read, null);
  });

  it("refuses a PO file the reader can't take, or a missing invoice, and keeps none of the files", async () => {
    const matching = pairMatching();
    const store = await freshStore(matching);
    const before = store.list().length;
    // Like a real upload: the files wait in a temporary folder, and a refusal must delete them.
    const uploads = await mkdtemp(join(tmpdir(), "po-upload-"));
    const temp = async (name: string, text: string) => {
      const path = join(uploads, name);
      await writeFile(path, text);
      return { name, path };
    };
    const refusedPo = [await temp("po.xml", "<xml/>")];
    const refusedInvoice = [await temp("i.pdf", "x")];
    await assert.rejects(store.addWithPo(refusedPo, refusedInvoice), /PO po\.xml: file type not supported/);
    const lonePo = [await temp("po.png", "x")];
    await assert.rejects(store.addWithPo(lonePo, []), /one supplier invoice/);
    assert.equal(store.list().length, before);
    assert.deepEqual(matching.steps, []);
    assert.deepEqual(await readdir(uploads), [], "temporary upload files deleted");
    assert.deepEqual(await readdir(join(config.uiStoreDir, "files")), [], "nothing kept");
  });
});
