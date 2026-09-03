import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DesktopSetup } from "@rakazo/contracts";
import { parseStoredSetup, SETUP_FILE_NAME, serializeSetup } from "./setup-config.js";

export function setupFilePath(userDataDir: string): string {
  return path.join(userDataDir, SETUP_FILE_NAME);
}

/** Returns null when setup has not run yet, or when the saved file is unusable. */
export async function readSetup(userDataDir: string): Promise<DesktopSetup | null> {
  let raw: string;
  try {
    raw = await readFile(setupFilePath(userDataDir), "utf8");
  } catch {
    return null;
  }
  return parseStoredSetup(raw);
}

export async function writeSetup(userDataDir: string, setup: DesktopSetup): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  await writePrivateFile(setupFilePath(userDataDir), serializeSetup(setup));
}

/**
 * Writes a file only its owner can read, atomically. Replacing the complete file
 * avoids following a malicious final symlink and leaves either the old or new
 * contents after an interrupted write.
 */
export async function writePrivateFile(destination: string, contents: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(contents, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, destination);
  } finally {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Removes saved setup so the next launch runs first-run again. */
export async function clearSetup(userDataDir: string): Promise<void> {
  await rm(setupFilePath(userDataDir), { force: true });
}
