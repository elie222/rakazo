import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { DesktopSetup } from "@rakazo/contracts";
import { parseStoredSetup, SETUP_FILE_NAME, serializeSetup } from "./setup-config.js";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const MAX_SETUP_BYTES = 64 * 1024;

export function setupFilePath(userDataDir: string): string {
  return path.join(userDataDir, SETUP_FILE_NAME);
}

/** Returns null when setup has not run yet, or when the saved file is unusable. */
export async function readSetup(userDataDir: string): Promise<DesktopSetup | null> {
  const raw = await readPrivateFile(setupFilePath(userDataDir), MAX_SETUP_BYTES);
  if (raw === null) return null;
  return parseStoredSetup(raw);
}

/** Reads a bounded regular file without accepting a final symlink. */
export async function readPrivateFile(file: string, maxBytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    handle = await open(file, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) return null;

    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > maxBytes ? null : buffer.subarray(0, offset).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
