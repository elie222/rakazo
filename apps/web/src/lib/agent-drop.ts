import type { AgentImportReader } from "@rakazo/core";
import {
  AGENT_IMPORT_ARCHIVE_LIMITS,
  agentImportFolder,
  isAgentHome,
  openAgentImportArchive,
} from "@rakazo/core";

export type CapturedDrop = { entries: FileSystemEntry[]; files: readonly File[] };

const ARCHIVE = /\.(?:zip|tar\.gz|tgz)$/i;
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__"]);
const MAX_LISTED = 50_000;

/** The browser empties `dataTransfer` once the drop handler returns, so copy it first. */
export function captureDrop(dataTransfer: DataTransfer): CapturedDrop {
  const entries = [...dataTransfer.items].flatMap((item) => {
    const entry = item.kind === "file" ? item.webkitGetAsEntry?.() : null;
    return entry ? [entry] : [];
  });
  return { entries, files: [...dataTransfer.files] };
}

/** One folder or one backup archive; anything else attaches as usual without a look. */
export function mightBeAgent(drop: CapturedDrop): boolean {
  if (drop.entries.length === 1 && drop.entries[0]!.isDirectory) return true;
  return drop.files.length === 1 && ARCHIVE.test(drop.files[0]!.name);
}

/** Null unless the drop is an OpenClaw or Hermes home. Lists names only; uploads nothing. */
export async function droppedAgent(drop: CapturedDrop): Promise<AgentImportReader | null> {
  const entry = drop.entries[0];
  if (drop.entries.length === 1 && entry?.isDirectory) {
    return folderSource(entry as FileSystemDirectoryEntry);
  }
  const file = drop.files[0];
  if (drop.files.length !== 1 || !file || !ARCHIVE.test(file.name)) return null;
  if (file.size > AGENT_IMPORT_ARCHIVE_LIMITS.archiveBytes) return null;
  try {
    const archive = openAgentImportArchive(new Uint8Array(await file.arrayBuffer()));
    return isAgentHome(archive.paths) ? archive : null;
  } catch {
    return null;
  }
}

async function folderSource(root: FileSystemDirectoryEntry): Promise<AgentImportReader | null> {
  const entries = new Map<string, FileSystemFileEntry>();
  await walk(root, entries);
  const paths = [...entries.keys()];
  if (!isAgentHome(paths)) return null;
  const wanted = new Set([
    ...agentImportFolder(paths).files.keys(),
    ...paths.filter((path) => path.endsWith("skills/.bundled_manifest")),
  ]);
  const files = new Map<string, File>();
  for (const path of wanted) {
    const entry = entries.get(path);
    if (entry)
      files.set(path, await new Promise<File>((resolve, reject) => entry.file(resolve, reject)));
  }
  return {
    paths,
    read: (path) => {
      const file = files.get(path);
      if (!file) throw new Error("Not a file an import reads");
      return file.text();
    },
    size: (path) => files.get(path)?.size,
  };
}

async function walk(
  directory: FileSystemDirectoryEntry,
  into: Map<string, FileSystemFileEntry>,
): Promise<void> {
  const reader = directory.createReader();
  for (;;) {
    // `readEntries` returns the listing in batches until an empty one.
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return;
    for (const entry of batch) {
      if (into.size >= MAX_LISTED) return;
      if (entry.isDirectory) {
        if (!SKIPPED_FOLDERS.has(entry.name)) {
          await walk(entry as FileSystemDirectoryEntry, into);
        }
      } else if (entry.isFile) {
        into.set(entry.fullPath.replace(/^\/+/, ""), entry as FileSystemFileEntry);
      }
    }
  }
}
