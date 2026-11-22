import type { AdapterContext, PortableFile, WorkspaceExportLimits } from "@rakazo/adapter-kit";
import { WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import { batchesOf } from "../../../computers/computer-workspace.js";
import {
  normalizeWorkspacePath,
  workspacePath,
} from "../../../computers/screens/computer-support.js";
import { shouldSkipPortableWorkspaceFile } from "../../../storage/workspace-save-policy.js";
import { daytonaRateLimitError } from "./daytona-rate-limit.js";
import type { DaytonaSandbox } from "./daytona-sandbox.js";

export function isDaytonaExecutable(mode: string, permissions: string): boolean {
  return /x/.test(permissions) || (Number.parseInt(mode, 8) & 0o100) !== 0;
}

export async function* walkDaytonaWorkspace(
  sandbox: DaytonaSandbox,
  root: string,
  directory: string,
  context: AdapterContext,
  limits?: WorkspaceExportLimits,
  counted = { bytes: 0, files: 0 },
): AsyncIterable<PortableFile> {
  if (context.signal.aborted) throw context.signal.reason ?? new Error("export aborted");
  const entries = await listDaytonaFolder(sandbox, root, directory);
  if (!entries) return;
  const files = entries
    .filter((entry) => !entry.isDir)
    .map((entry) => ({
      entry,
      relative: normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name),
    }))
    .filter(({ relative }) => !shouldSkipPortableWorkspaceFile(relative));
  const directories = entries.filter((entry) => entry.isDir);
  if (limits) {
    // Sizes come from the listing: refuse before any file of this folder is downloaded.
    for (const { entry } of files) {
      counted.files += 1;
      counted.bytes += entry.size;
    }
    if (counted.files > limits.maxFiles) throw new WorkspaceTooLargeError("files");
    if (counted.bytes > limits.maxBytes) throw new WorkspaceTooLargeError("bytes");
  }
  for (const entries of batchesOf(files, 8, (file) => file.entry.size)) {
    const batch = await Promise.all(
      entries.map(async ({ entry, relative }) => {
        const content = await downloadDaytonaFile(sandbox, root, relative);
        if (!content) return undefined;
        return {
          path: relative,
          content: new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
          executable: isDaytonaExecutable(entry.mode, entry.permissions),
        };
      }),
    );
    for (const file of batch) if (file) yield file;
  }
  for (const entry of directories) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (!shouldSkipPortableWorkspaceFile(relative, true)) {
      yield* walkDaytonaWorkspace(sandbox, root, relative, context, limits, counted);
    }
  }
}

/** Lists a folder. A subfolder deleted since its parent listed it is left out, the root never. */
async function listDaytonaFolder(sandbox: DaytonaSandbox, root: string, directory: string) {
  try {
    return await sandbox.fs.listFiles(workspacePath(root, directory));
  } catch (error) {
    const limited = await daytonaRateLimitError(error);
    if (limited) throw limited;
    if (directory && (await isVanishedEntry(sandbox, root, error))) return undefined;
    throw error;
  }
}

/** Downloads a file. One deleted since it was listed is left out. */
async function downloadDaytonaFile(sandbox: DaytonaSandbox, root: string, relative: string) {
  try {
    return await sandbox.fs.downloadFile(workspacePath(root, relative));
  } catch (error) {
    const limited = await daytonaRateLimitError(error);
    if (limited) throw limited;
    if (await isVanishedEntry(sandbox, root, error)) return undefined;
    throw error;
  }
}

/**
 * Not found for an entry that was listed before. A deleted sandbox also answers not found, and
 * skipping its entries would commit a partial home, so the entry only counts as gone while the
 * workspace root still lists. Any other error is not vanished and propagates.
 */
async function isVanishedEntry(
  sandbox: DaytonaSandbox,
  root: string,
  error: unknown,
): Promise<boolean> {
  if ((error as { statusCode?: unknown } | null)?.statusCode !== 404) return false;
  try {
    await sandbox.fs.listFiles(workspacePath(root, ""));
  } catch {
    throw error;
  }
  return true;
}
