import { Gunzip, Inflate } from "fflate";
import { AGENT_IMPORT_CONFIG_FILES } from "./config.js";

/**
 * Reads an OpenClaw or Hermes backup in the browser, so secret files never leave the
 * device unless the user opts in. Only files an import might use are decompressed and read;
 * every other entry is listed by name only (or, inside a gzip stream, skipped).
 */

export const AGENT_IMPORT_ARCHIVE_LIMITS = {
  /** The backup file itself. */
  archiveBytes: 256 * 1024 * 1024,
  entries: 50_000,
  /** One file that is read. Larger files are never sent (the upload cap is far lower). */
  fileBytes: 1024 * 1024,
  /** Everything read, before the upload's own total cap. */
  readBytes: 8 * 1024 * 1024,
  /** Everything a gzip stream inflates to, including skipped entries. */
  inflatedBytes: 512 * 1024 * 1024,
  /** Inflated size per compressed byte above which data is treated as a bomb. */
  ratio: 200,
} as const;

export type AgentImportArchiveLimits = Record<keyof typeof AGENT_IMPORT_ARCHIVE_LIMITS, number>;

export type AgentImportArchiveErrorReason = "unreadable" | "too_large";

export class AgentImportArchiveError extends Error {
  constructor(readonly reason: AgentImportArchiveErrorReason) {
    super(reason === "too_large" ? "The backup is too large." : "The backup could not be read.");
    this.name = "AgentImportArchiveError";
  }
}

const unreadable = () => new AgentImportArchiveError("unreadable");
const tooLarge = () => new AgentImportArchiveError("too_large");

/** One file in an archive: its path and, when it was read, its bytes. */
type Entry = { path: string; size?: number; data?: Uint8Array };

/**
 * Opens a backup: its files listed under a folder name the import recognises (`.openclaw/...`
 * or `.hermes/...` when the layout is known), and a reader that decompresses one file at a
 * time. Files outside what an import reads were never kept, so reading them fails.
 */
export function openAgentImportArchive(
  data: Uint8Array,
  limits: AgentImportArchiveLimits = AGENT_IMPORT_ARCHIVE_LIMITS,
): {
  paths: string[];
  read: (path: string) => string;
  size: (path: string) => number | undefined;
} {
  if (data.length > limits.archiveBytes) throw tooLarge();
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  const isGzip = data[0] === 0x1f && data[1] === 0x8b;
  if (!isZip && !isGzip) throw unreadable();
  const zip = isZip ? zipEntries(data, limits) : null;
  const entries = zip ? zip.entries : tarEntries(data, limits);
  const layout = archiveLayout(entries);
  const paths: string[] = [];
  const byVirtual = new Map<string, Entry>();
  for (const entry of entries) {
    const path = layout(entry.path);
    if (!path) continue;
    // Two entries for one file (repeated, or equal after normalising) are ambiguous.
    if (byVirtual.has(path)) throw unreadable();
    paths.push(path);
    byVirtual.set(path, entry);
  }
  let read = 0;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    paths,
    size: (path) => byVirtual.get(path)?.size,
    read: (path) => {
      const entry = byVirtual.get(path);
      const bytes = entry && (entry.data ?? zip?.read(entry.path));
      if (!bytes) throw tooLarge();
      read += bytes.length;
      if (read > limits.readBytes) throw tooLarge();
      return decoder.decode(bytes);
    },
  };
}

/**
 * An archive path made relative and safe, or null for a directory. Absolute paths, drive
 * letters, backslashes, NUL and `..` make the whole archive unreadable.
 */
export function safeArchivePath(raw: string): string | null {
  if (raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw unreadable();
  }
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw unreadable();
  if (raw.endsWith("/") || segments.length === 0) return null;
  return segments.join("/");
}

/** Files an import might read; only these are kept while a gzip stream is inflated. */
function mayBeRead(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return (
    name.toLowerCase().endsWith(".md") ||
    name === "manifest.json" ||
    name === "jobs.json" ||
    name === ".bundled_manifest" ||
    AGENT_IMPORT_CONFIG_FILES.has(name)
  );
}

const NESTED_ARCHIVE = /\.(?:zip|tar|tgz|gz|bz2|xz|7z|rar)$/i;

// ---------------------------------------------------------------------------------- zip

function zipEntries(data: Uint8Array, limits: AgentImportArchiveLimits) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw unreadable();
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  // ZIP64 archives mark these fields as saturated; they are refused rather than misread.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw unreadable();
  if (count > limits.entries) throw tooLarge();
  if (offset + size > data.length) throw unreadable();
  type ZipEntry = Entry & { method: number; compressed: number; size: number; local: number };
  const entries: ZipEntry[] = [];
  let at = offset;
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > data.length || view.getUint32(at, true) !== 0x02014b50) throw unreadable();
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    const path = safeArchivePath(name);
    const type = (external >>> 16) & 0o170000;
    // Directories, links, devices, encrypted entries and archives inside are never read.
    if (!path || (type !== 0 && type !== 0o100000) || flags & 1 || NESTED_ARCHIVE.test(path)) {
      continue;
    }
    if (method !== 0 && method !== 8) continue;
    entries.push({ path, method, compressed, size: uncompressed, local });
  }
  const read = (path: string): Uint8Array | undefined => {
    const entry = entries.find((candidate) => candidate.path === path);
    if (!entry) return undefined;
    if (entry.size > limits.fileBytes) return undefined;
    if (entry.size > 1024 * 1024 && entry.size > entry.compressed * limits.ratio) throw tooLarge();
    if (entry.local + 30 > data.length || view.getUint32(entry.local, true) !== 0x04034b50) {
      throw unreadable();
    }
    const start =
      entry.local +
      30 +
      view.getUint16(entry.local + 26, true) +
      view.getUint16(entry.local + 28, true);
    const body = data.subarray(start, start + entry.compressed);
    if (body.length !== entry.compressed) throw unreadable();
    if (entry.method === 0) return body.length > limits.fileBytes ? undefined : body;
    return inflateCapped(body, Math.min(entry.size, limits.fileBytes));
  };
  return { entries: entries as Entry[], read };
}

/** Raw DEFLATE, stopped as soon as the output passes the declared size. */
function inflateCapped(body: Uint8Array, cap: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const inflate = new Inflate((chunk) => {
    total += chunk.length;
    if (total > cap) throw tooLarge();
    parts.push(chunk);
  });
  feed(body, (chunk, final) => inflate.push(chunk, final));
  return concat(parts, total);
}

// ------------------------------------------------------------------------------ tar.gz

/**
 * Inflates a gzip stream and parses the tar inside as it arrives (ustar, pax and GNU long
 * names). Only entries an import might read are kept; links, devices and other types are
 * skipped. Stops at the first cap passed.
 */
function tarEntries(data: Uint8Array, limits: AgentImportArchiveLimits): Entry[] {
  const entries: Entry[] = [];
  const tar = new TarStream(entries, limits);
  let inflated = 0;
  const gunzip = new Gunzip((chunk) => {
    inflated += chunk.length;
    if (inflated > limits.inflatedBytes) throw tooLarge();
    if (inflated > 1024 * 1024 && inflated > data.length * limits.ratio) throw tooLarge();
    tar.push(chunk);
  });
  try {
    feed(data, (chunk, final) => gunzip.push(chunk, final));
  } catch (error) {
    if (error instanceof AgentImportArchiveError) throw error;
    throw unreadable();
  }
  tar.finish();
  return entries;
}

class TarStream {
  private header = new Uint8Array(512);
  private headerFill = 0;
  /** Bytes left in the current entry's data, then its padding. */
  private remaining = 0;
  private padding = 0;
  private current: { path: string | null; kind: "file" | "pax" | "longname" | "skip" } | null =
    null;
  private buffer: Uint8Array[] = [];
  private bufferSize = 0;
  private keep = false;
  private nextName: string | null = null;
  private ended = false;
  private count = 0;
  private sawHeader = false;

  constructor(
    private readonly entries: Entry[],
    private readonly limits: AgentImportArchiveLimits,
  ) {}

  push(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length && !this.ended) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - at);
        if (this.keep) {
          this.buffer.push(chunk.slice(at, at + take));
          this.bufferSize += take;
        }
        this.remaining -= take;
        at += take;
        if (this.remaining === 0) this.endData();
        continue;
      }
      if (this.padding > 0) {
        const take = Math.min(this.padding, chunk.length - at);
        this.padding -= take;
        at += take;
        continue;
      }
      const take = Math.min(512 - this.headerFill, chunk.length - at);
      this.header.set(chunk.subarray(at, at + take), this.headerFill);
      this.headerFill += take;
      at += take;
      if (this.headerFill === 512) {
        this.headerFill = 0;
        this.readHeader();
      }
    }
  }

  finish(): void {
    // A stream that stops inside a header or an entry's data is truncated.
    if (!this.sawHeader || this.remaining > 0 || this.headerFill > 0) throw unreadable();
  }

  private readHeader(): void {
    const block = this.header;
    if (block.every((byte) => byte === 0)) {
      this.ended = this.sawHeader;
      if (!this.sawHeader) throw unreadable();
      return;
    }
    if (!validChecksum(block)) throw unreadable();
    this.sawHeader = true;
    this.count += 1;
    if (this.count > this.limits.entries) throw tooLarge();
    const size = readSize(block.subarray(124, 136));
    const type = String.fromCharCode(block[156] ?? 0);
    const ustar = ascii(block.subarray(257, 262)) === "ustar";
    const prefix = ustar ? ascii(block.subarray(345, 500)) : "";
    const name =
      this.nextName ??
      (prefix ? `${prefix}/${ascii(block.subarray(0, 100))}` : ascii(block.subarray(0, 100)));
    this.remaining = size;
    this.padding = (512 - (size % 512)) % 512;
    this.buffer = [];
    this.bufferSize = 0;
    this.keep = false;
    if (type === "x") {
      this.current = { path: null, kind: "pax" };
      this.keep = size <= 64 * 1024;
    } else if (type === "L") {
      this.current = { path: null, kind: "longname" };
      this.keep = size <= 64 * 1024;
    } else if (type === "0" || type === "\0" || type === "7") {
      this.nextName = null;
      const path = safeArchivePath(name);
      const read = path !== null && !NESTED_ARCHIVE.test(path) && mayBeRead(path);
      this.current = { path, kind: "file" };
      this.keep = read && size <= this.limits.fileBytes;
      if (path) this.entries.push({ path, size });
    } else {
      // Directories, links, devices, FIFOs, global headers and anything unknown.
      this.nextName = null;
      if (type === "5") safeArchivePath(name);
      this.current = { path: null, kind: "skip" };
    }
    if (size === 0) this.endData();
  }

  private endData(): void {
    const current = this.current;
    this.current = null;
    if (!current || !this.keep) return;
    const bytes = concat(this.buffer, this.bufferSize);
    if (current.kind === "pax") this.nextName = paxPath(bytes);
    else if (current.kind === "longname") this.nextName = ascii(bytes);
    else if (current.kind === "file" && current.path) {
      const entry = this.entries.at(-1);
      if (entry?.path === current.path) entry.data = bytes;
    }
  }
}

function validChecksum(block: Uint8Array): boolean {
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
  }
  return Number.parseInt(ascii(block.subarray(148, 156)).trim() || "-1", 8) === sum;
}

function readSize(field: Uint8Array): number {
  // Base-256 for sizes past the octal field's range.
  if ((field[0] ?? 0) & 0x80) {
    let value = (field[0] ?? 0) & 0x7f;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + (field[index] ?? 0);
    if (!Number.isSafeInteger(value)) throw tooLarge();
    return value;
  }
  const text = ascii(field).trim();
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isFinite(value) || value < 0) throw unreadable();
  return value;
}

/** The `path` record of a pax header (`<length> path=<value>\n`). */
function paxPath(bytes: Uint8Array): string | null {
  const text = new TextDecoder().decode(bytes);
  for (const line of text.split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

function ascii(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

// ----------------------------------------------------------------------------- layout

/**
 * Where a backup keeps the agent's home, as a function from archive path to the path the
 * import reads (`.openclaw/...`, `.hermes/...`), or null for files outside it.
 *
 * OpenClaw backups hold `<name>/manifest.json` and `<name>/payload/posix/<original path>`:
 * the `state` asset is the home, and a `workspace` asset outside it becomes its workspace.
 * Hermes backups hold the home's files at the archive root.
 */
function archiveLayout(entries: Entry[]): (path: string) => string | null {
  const manifest = entries.find((entry) => /^[^/]+\/manifest\.json$/.test(entry.path));
  if (manifest?.data) {
    const roots = openClawRoots(
      manifest,
      entries.map((entry) => entry.path),
    );
    if (roots) {
      return (path) => {
        if (path.startsWith(`${roots.home}/`))
          return `.openclaw/${path.slice(roots.home.length + 1)}`;
        if (roots.workspace && path.startsWith(`${roots.workspace}/`)) {
          return `.openclaw/workspace/${path.slice(roots.workspace.length + 1)}`;
        }
        return null;
      };
    }
  }
  const paths = entries.map((entry) => entry.path);
  const config = paths
    .filter((path) => path === "openclaw.json" || path.endsWith("/openclaw.json"))
    .sort((left, right) => left.length - right.length)[0];
  if (config !== undefined) {
    const home = config.slice(0, -"openclaw.json".length).replace(/\/$/, "");
    return (path) =>
      home === ""
        ? `.openclaw/${path}`
        : path.startsWith(`${home}/`)
          ? `.openclaw/${path.slice(home.length + 1)}`
          : null;
  }
  const hermes = paths.some(
    (path) => path === "config.yaml" || path === "SOUL.md" || path.startsWith("memories/"),
  );
  if (hermes) return (path) => `.hermes/${path}`;
  return (path) => path;
}

function openClawRoots(
  manifest: Entry,
  paths: readonly string[],
): { home: string; workspace?: string } | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(manifest.data)) as {
      schemaVersion?: number;
      archiveRoot?: string;
      assets?: { kind?: string; archivePath?: string }[];
    };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.assets)) return null;
    const folder = manifest.path.slice(0, -"/manifest.json".length);
    // The manifest describes this archive only if it names the folder it sits in.
    if (parsed.archiveRoot !== undefined && parsed.archiveRoot !== folder) throw unreadable();
    const inArchive = (archivePath: string) => {
      const relative = safeArchivePath(archivePath.replace(/\/+$/, ""));
      if (!relative) return null;
      return relative.startsWith(`${folder}/`) ? relative : `${folder}/${relative}`;
    };
    const state = parsed.assets.find((asset) => asset.kind === "state" && asset.archivePath);
    const home = state?.archivePath ? inArchive(state.archivePath) : null;
    if (!home) return null;
    // Every declared asset must exist in the archive, under its root folder.
    for (const asset of parsed.assets) {
      if (!asset.archivePath) continue;
      const declared = inArchive(asset.archivePath);
      if (!declared || !paths.some((path) => path.startsWith(`${declared}/`))) throw unreadable();
    }
    const workspace = parsed.assets
      .filter((asset) => asset.kind === "workspace" && asset.archivePath)
      .map((asset) => inArchive(asset.archivePath!))
      .find((path) => path && !path.startsWith(`${home}/`));
    return workspace ? { home, workspace } : { home };
  } catch (error) {
    if (error instanceof AgentImportArchiveError) throw error;
    return null;
  }
}

// ---------------------------------------------------------------------------- helpers

/** Pushes data in small chunks, so a cap is noticed before much is inflated. */
function feed(data: Uint8Array, push: (chunk: Uint8Array, final: boolean) => void): void {
  const size = 16 * 1024;
  if (data.length === 0) push(data, true);
  for (let at = 0; at < data.length; at += size) {
    push(data.subarray(at, at + size), at + size >= data.length);
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
