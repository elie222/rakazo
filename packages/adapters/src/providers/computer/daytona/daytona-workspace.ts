import type { AdapterContext, PortableFile, WorkspaceExportLimits } from "@rakazo/adapter-kit";
import { WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import { PortableFileBatcher } from "../../../computers/computer-workspace.js";
import {
  normalizeWorkspacePath,
  workspacePath,
} from "../../../computers/screens/computer-support.js";
import { shouldSkipPortableWorkspaceFile } from "../../../storage/workspace-save-policy.js";
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
  const entries = await sandbox.fs.listFiles(workspacePath(root, directory));
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
  for (const entries of daytonaExportBatches(files)) {
    const batch = await Promise.all(
      entries.map(async ({ entry, relative }) => {
        const content = await sandbox.fs.downloadFile(workspacePath(root, relative));
        return {
          path: relative,
          content: new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
          executable: isDaytonaExecutable(entry.mode, entry.permissions),
        };
      }),
    );
    for (const file of batch) yield file;
  }
  for (const entry of directories) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (!shouldSkipPortableWorkspaceFile(relative, true)) {
      yield* walkDaytonaWorkspace(sandbox, root, relative, context, limits, counted);
    }
  }
}

function daytonaExportBatches<T extends { entry: { size: number } }>(files: readonly T[]): T[][] {
  const batches: T[][] = [];
  const batcher = new PortableFileBatcher<T>(8, (file) => file.entry.size);
  for (const file of files) {
    const full = batcher.add(file);
    if (full?.length) batches.push(full);
  }
  const last = batcher.take();
  if (last.length) batches.push(last);
  return batches;
}
