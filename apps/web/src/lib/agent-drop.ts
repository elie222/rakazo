import {
  AGENT_IMPORT_ARCHIVE_LIMITS,
  agentImportFolder,
  isAgentHome,
  openAgentImportArchive,
} from "@rakazo/core";

/** A chosen folder or opened backup: its paths, and its files read on demand. */
export type DroppedAgent = {
  paths: string[];
  read: (path: string) => Promise<string> | string;
  size: (path: string) => number | undefined;
};

/** What a drop carried, captured during the event (entries are gone after it). */
export type CapturedDrop = { entries: FileSystemEntry[]; files: File[] };

const ARCHIVE = /\.(?:zip|tar\.gz|tgz)$/i;
/** Folders an agent home never needs, skipped while listing a dropped folder. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__"]);
const MAX_LISTED = 50_000;

export function captureDrop(dataTransfer: DataTransfer): CapturedDrop {
  const entries = [...dataTransfer.items].flatMap((item) => {
    const entry = item.kind === "file" ? item.webkitGetAsEntry?.() : null;
    return entry ? [entry] : [];
  });
  return { entries, files: [...dataTransfer.files] };
}

/**
 * Whether a drop might be an agent: one folder, or one `.zip`/`.tar.gz`/`.tgz`. Anything
 * else (images, documents, several items) is attached as before without looking further.
 */
export function mightBeAgent(drop: CapturedDrop): boolean {
  if (drop.entries.length === 1 && drop.entries[0]!.isDirectory) return true;
  return drop.files.length === 1 && ARCHIVE.test(drop.files[0]!.name);
}

/**
 * The dropped folder or backup as an import source, or null when its file names are not
 * an OpenClaw or Hermes home. Only names are listed here; nothing is uploaded, and file
 * contents are read later, by the import form, and only for the files an import uses.
 */
export async function droppedAgent(drop: CapturedDrop): Promise<DroppedAgent | null> {
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
    // Not a backup this import can read: it stays an ordinary attachment.
    return null;
  }
}

async function folderSource(root: FileSystemDirectoryEntry): Promise<DroppedAgent | null> {
  const entries = new Map<string, FileSystemFileEntry>();
  await walk(root, entries);
  const paths = [...entries.keys()];
  if (!isAgentHome(paths)) return null;
  // Only the files an import may read are opened (their size is known without reading).
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
