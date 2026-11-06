import { constants } from "node:fs";
import { open, realpath, stat, unlink } from "node:fs/promises";
import { basename, sep } from "node:path";
import { formatToolFileSize, toolFileMention } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { ToolFileScope, ToolFileStore } from "./tool-files.js";

/** Where files a tool produced are stored, and whose they are. */
export type ToolFileCaptureTarget = {
  store: ToolFileStore;
  scope: ToolFileScope;
  runId?: string | null;
};

/**
 * Files larger than this are never read into memory, whatever the store accepts; the model is
 * told the file was too large instead.
 */
export const MAX_CAPTURED_TOOL_FILE_BYTES = 50 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/plain": "txt",
};

const EXTENSION_MIME_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MIME_EXTENSIONS).map(([mime, ext]) => [ext, mime])),
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
};

function extensionFor(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType.split(";")[0]!.trim().toLowerCase()] ?? "bin";
}

function mimeTypeForName(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXTENSION_MIME_TYPES[ext] ?? "application/octet-stream";
}

/** A file name safe to show and store: no directories, control characters or overlong text. */
export function safeFileName(raw: string, fallback: string): string {
  const name = raw
    .split(/[/\\]/)
    .pop()!
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 200);
  return name && name !== "." && name !== ".." ? name : fallback;
}

function uriFileName(uri: unknown): string {
  if (typeof uri !== "string") return "";
  try {
    const path = new URL(uri).pathname;
    return decodeURIComponent(path.split("/").pop() ?? "");
  } catch {
    return uri.split(/[?#]/)[0]!.split("/").pop() ?? "";
  }
}

function tooLargeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ToolFileTooLargeError" || /too large|exceeds/i.test(error.message))
  );
}

function tooLargeNote(name: string, mimeType: string, size: number): string {
  return `[file "${name}" (${mimeType}, ${formatToolFileSize(size)}) was too large to keep, so it cannot be passed to another tool.]`;
}

/** Store bytes and describe them for the model, or say why they could not be kept. */
async function storeForModel(
  target: ToolFileCaptureTarget,
  file: { name: string; mimeType: string; bytes: Uint8Array },
): Promise<string> {
  try {
    const ref = await target.store.create({
      ...target.scope,
      runId: target.runId ?? null,
      name: file.name,
      mimeType: file.mimeType,
      bytes: file.bytes,
    });
    return toolFileMention(ref);
  } catch (error) {
    if (tooLargeError(error)) return tooLargeNote(file.name, file.mimeType, file.bytes.length);
    // The message may quote the file name or storage details; log only that it failed.
    getLogger().warn("tool_file.capture_failed", { "file.size": file.bytes.length });
    return `[file "${file.name}" (${file.mimeType}, ${formatToolFileSize(file.bytes.length)}) could not be kept, so it cannot be passed to another tool.]`;
  }
}

type ContentItem = Record<string, unknown> & { type?: unknown };

function binaryItem(
  item: unknown,
):
  | { kind: "image" | "audio"; data: string; mimeType: string }
  | { kind: "resource"; data: string; mimeType: string; uri: unknown }
  | undefined {
  if (!item || typeof item !== "object") return undefined;
  const entry = item as ContentItem;
  if ((entry.type === "image" || entry.type === "audio") && typeof entry.data === "string")
    return {
      kind: entry.type,
      data: entry.data,
      mimeType:
        typeof entry.mimeType === "string" && entry.mimeType
          ? entry.mimeType
          : "application/octet-stream",
    };
  const resource = entry.resource as Record<string, unknown> | undefined;
  if (entry.type === "resource" && resource && typeof resource.blob === "string")
    return {
      kind: "resource",
      data: resource.blob,
      mimeType:
        typeof resource.mimeType === "string" && resource.mimeType
          ? resource.mimeType
          : "application/octet-stream",
      uri: resource.uri,
    };
  return undefined;
}

/**
 * Replace an MCP result's images, audio and embedded binary resources with mentions of stored
 * temporary files, so their bytes never reach the model. Text content, including text
 * resources, stays as it is. Never throws: a file that cannot be kept becomes a short note.
 */
export async function captureMcpBinaryContent(
  result: unknown,
  target: ToolFileCaptureTarget,
): Promise<unknown> {
  if (!result || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || !content.some((item) => binaryItem(item))) return result;
  const counters = new Map<string, number>();
  const replaced: unknown[] = [];
  for (const item of content) {
    const binary = binaryItem(item);
    if (!binary) {
      replaced.push(item);
      continue;
    }
    const count = (counters.get(binary.kind) ?? 0) + 1;
    counters.set(binary.kind, count);
    const fallback = `${binary.kind}-${count}.${extensionFor(binary.mimeType)}`;
    const name = safeFileName(binary.kind === "resource" ? uriFileName(binary.uri) : "", fallback);
    // base64 holds 3 bytes in every 4 characters.
    const estimated = Math.floor((binary.data.length * 3) / 4);
    if (estimated > MAX_CAPTURED_TOOL_FILE_BYTES) {
      replaced.push({ type: "text", text: tooLargeNote(name, binary.mimeType, estimated) });
      continue;
    }
    const bytes = new Uint8Array(Buffer.from(binary.data, "base64"));
    replaced.push({
      type: "text",
      text: await storeForModel(target, { name, mimeType: binary.mimeType, bytes }),
    });
  }
  return { ...(result as object), content: replaced };
}

/** Every string inside a value, keys excluded. */
function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectStrings(item, into);
  return into;
}

/** A copy of a value with `map` applied to every string inside it, keys excluded. */
export function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]),
    );
  return value;
}

/** A candidate path ends at the end of the text or before one of these. */
const PATH_END = /[\s,;:)\]}.!?'"`<>|]/;
/** A path is never longer than this, nor does it cross these. */
const PATH_MAX_LENGTH = 4096;
const PATH_STOP = /[\r\n\0"'`<>|]/;
/** Readings of one mention tried at most, so a long sentence after a path stays cheap. */
const PATH_MAX_READINGS = 64;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a path only where it ends, not as the start of a longer name. */
function pathPattern(path: string): RegExp {
  return new RegExp(`${escapeRegExp(path)}(?![\\w-])`, "g");
}

/** The real path of a regular file inside one of `roots` and none of `excluded`, or undefined. */
async function fileInside(
  roots: string[],
  excluded: string[],
  path: string,
): Promise<string | undefined> {
  const real = await realpath(path).catch(() => undefined);
  if (!real || !roots.some((root) => real.startsWith(root + sep))) return undefined;
  if (excluded.some((dir) => real === dir || real.startsWith(dir + sep))) return undefined;
  return (await stat(real).catch(() => undefined))?.isFile() ? real : undefined;
}

/** Read a regular file without following a symlink at its last component. */
async function readRegularFile(
  real: string,
): Promise<{ bytes: Uint8Array } | { tooLarge: number } | undefined> {
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (info.size > MAX_CAPTURED_TOOL_FILE_BYTES) return { tooLarge: info.size };
    return { bytes: new Uint8Array(await handle.readFile()) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Paths in `text` that start with one of `prefixes` and name a regular file inside `roots`,
 * keyed by the text as written. File names may hold spaces, so each mention is tried from its
 * longest reading down to the shortest one that ends at a path boundary.
 */
async function namedFiles(
  text: string,
  prefixes: string[],
  roots: string[],
  excluded: string[],
  found: Map<string, string>,
): Promise<void> {
  for (const prefix of prefixes) {
    for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
      let rest = text.slice(at, at + PATH_MAX_LENGTH);
      const stop = rest.search(PATH_STOP);
      if (stop !== -1) rest = rest.slice(0, stop);
      let readings = 0;
      for (let end = rest.length; end > prefix.length; end -= 1) {
        if (end < rest.length && !PATH_END.test(rest[end]!)) continue;
        if (++readings > PATH_MAX_READINGS) break;
        const candidate = rest.slice(0, end);
        if (found.has(candidate)) break;
        const real = await fileInside(roots, excluded, candidate);
        if (real) {
          found.set(candidate, real);
          break;
        }
      }
    }
  }
}

/**
 * Import the files a result names from a stdio server's private workspace: each path in the
 * result that resolves to a regular file inside one of `roots` is stored as a temporary tool
 * file, deleted from disk, and replaced in the result by the file's mention. One process serves
 * all of a user's agents, so files the result does not name are left alone (another call may
 * own them). Paths that resolve outside the roots, through a symlink or `..`, or into an
 * `excluded` folder, are ignored. Never throws.
 */
export async function importOutputFiles(
  result: unknown,
  roots: string[],
  target: ToolFileCaptureTarget,
  excluded: string[] = [],
): Promise<unknown> {
  try {
    const realRoots = (
      await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)))
    ).filter((root): root is string => Boolean(root));
    if (realRoots.length === 0) return result;
    const realExcluded = (
      await Promise.all(excluded.map((dir) => realpath(dir).catch(() => undefined)))
    ).filter((dir): dir is string => Boolean(dir));
    const prefixes = [...new Set([...roots, ...realRoots])].map((root) =>
      root.endsWith(sep) ? root : root + sep,
    );
    const strings = collectStrings(result).filter((text) =>
      prefixes.some((prefix) => text.includes(prefix)),
    );
    if (strings.length === 0) return result;
    const found = new Map<string, string>();
    for (const text of strings) await namedFiles(text, prefixes, realRoots, realExcluded, found);
    if (found.size === 0) return result;
    const mentions = new Map<string, string>();
    const replacements: Array<{ pattern: RegExp; text: string }> = [];
    // Longest first, so "a.pdf" is never replaced inside a mention of "a.pdf 2.pdf".
    for (const [written, real] of [...found].sort(([a], [b]) => b.length - a.length)) {
      let mention = mentions.get(real);
      if (mention === undefined) {
        const read = await readRegularFile(real).catch(() => undefined);
        if (!read) continue;
        const name = safeFileName(basename(real), "file");
        const mimeType = mimeTypeForName(name);
        mention =
          "tooLarge" in read
            ? tooLargeNote(name, mimeType, read.tooLarge)
            : await storeForModel(target, { name, mimeType, bytes: read.bytes });
        await unlink(real).catch(() => undefined);
        mentions.set(real, mention);
      }
      replacements.push({ pattern: pathPattern(written), text: mention });
    }
    if (replacements.length === 0) return result;
    return mapStrings(result, (value) =>
      replacements.reduce(
        (current, { pattern, text }) => current.replace(new RegExp(pattern), () => text),
        value,
      ),
    );
  } catch {
    getLogger().warn("tool_file.output_import_failed");
    return result;
  }
}
