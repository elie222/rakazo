import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  await writeFile(setupFilePath(userDataDir), serializeSetup(setup), "utf8");
}

export async function clearSetup(userDataDir: string): Promise<void> {
  await rm(setupFilePath(userDataDir), { force: true });
}
