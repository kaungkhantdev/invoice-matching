import { existsSync } from "node:fs";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Entry, IncomingFile } from "./entry.js";

/** The saved invoice list, or null on the first start. Lists saved by older versions get the fields added since. */
export async function loadEntries(storeFile: string): Promise<Entry[] | null> {
  if (!existsSync(storeFile)) return null;
  const saved = JSON.parse(await readFile(storeFile, "utf8")) as Entry[];
  return saved.map((entry) => ({
    ...entry,
    attempts: entry.attempts ?? 0,
    retryError: entry.retryError ?? null,
  }));
}

/** Write to a temporary file, then rename: a crash mid-write can't leave a broken store.json. */
export async function writeAtomically(file: string, text: string): Promise<void> {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

/** Keep an added file at `target`: a big upload is moved from its temporary folder, a file in memory is written. */
export async function keepFile(file: IncomingFile, data: Buffer, target: string): Promise<void> {
  if ("path" in file) await moveFile(file.path, target);
  else await writeFile(target, data);
}

/** Delete the temporary copy of an upload that was not added. */
export async function discardUpload(file: IncomingFile): Promise<void> {
  if ("path" in file) await rm(file.path, { force: true });
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    // Different disk (e.g. /tmp): copy, then remove.
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}
