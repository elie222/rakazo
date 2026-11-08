import type { BotPackageExport } from "@rakazo/contracts";
import { BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import { downloadArtifactBytes } from "./artifact-open";

/** Packages have a separate byte budget from chat attachments. */
export async function readBotPackageFile(file: File, isCurrent: () => boolean): Promise<string> {
  if (!isCurrent()) throw new Error("This package editor is no longer current.");
  if (file.size > BOT_PACKAGE_MAX_BYTES) throw new Error("Bot packages must be at most 4 MiB.");
  const bytes = await file.slice(0, BOT_PACKAGE_MAX_BYTES + 1).arrayBuffer();
  if (!isCurrent()) throw new Error("This package editor is no longer current.");
  if (bytes.byteLength > BOT_PACKAGE_MAX_BYTES)
    throw new Error("Bot packages must be at most 4 MiB.");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function downloadBotPackage(result: BotPackageExport, isCurrent: () => boolean): void {
  if (!isCurrent()) throw new Error("This package editor is no longer current.");
  const bytes = new TextEncoder().encode(result.json);
  if (bytes.byteLength > BOT_PACKAGE_MAX_BYTES)
    throw new Error("Bot packages must be at most 4 MiB.");
  const stem = result.filename
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 120);
  const name = stem ? (stem.endsWith(".json") ? stem : `${stem}.json`) : "bot-package.json";
  downloadArtifactBytes(name, "application/json", bytes);
}
