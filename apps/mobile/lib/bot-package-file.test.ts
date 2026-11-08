import { BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  pick: vi.fn(),
  available: vi.fn(),
  share: vi.fn(),
  bytes: new Uint8Array(),
  infoSize: undefined as number | undefined,
  inputInfo: vi.fn(),
  openError: false,
  readError: false,
  cleanupError: false,
  readLengths: [] as number[],
  close: vi.fn(),
  afterWrite: undefined as undefined | (() => void),
  infoSizes: new Map<string, number | undefined>(),
  directories: new Set<string>(),
  files: new Map<string, Uint8Array>(),
  created: [] as string[],
  deleted: [] as string[],
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: io.pick }));
vi.mock("expo-sharing", () => ({ isAvailableAsync: io.available, shareAsync: io.share }));
vi.mock("expo-file-system", () => {
  class Node {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get name() {
      return this.uri.split("/").at(-1)!;
    }
  }
  class Directory extends Node {
    get exists() {
      return io.directories.has(this.uri);
    }
    list() {
      return [...io.directories]
        .filter(
          (uri) => uri.startsWith(`${this.uri}/`) && !uri.slice(this.uri.length + 1).includes("/"),
        )
        .map((uri) => new Directory(uri));
    }
    create() {
      if (io.directories.has(this.uri)) throw new Error("Already exists");
      io.directories.add(this.uri);
      io.created.push(this.uri);
    }
    delete() {
      if (io.cleanupError) throw new Error("Cannot delete");
      io.deleted.push(this.uri);
      io.directories.delete(this.uri);
      for (const path of io.directories)
        if (path.startsWith(`${this.uri}/`)) io.directories.delete(path);
      for (const path of io.files.keys())
        if (path.startsWith(`${this.uri}/`)) io.files.delete(path);
    }
  }
  class File extends Node {
    get exists() {
      return io.files.has(this.uri);
    }
    info() {
      const input = this.uri.startsWith("file:///picked/") || this.uri.startsWith("content://");
      if (input) io.inputInfo();
      return {
        size: io.infoSizes.has(this.uri)
          ? io.infoSizes.get(this.uri)
          : input
            ? io.infoSize
            : io.files.get(this.uri)?.byteLength,
        exists: input || this.exists,
      };
    }
    textSync() {
      return new TextDecoder().decode(io.files.get(this.uri));
    }
    open(mode: string) {
      expect(mode).toBe("r");
      if (io.openError) throw new Error("Provider does not support a read-only file handle");
      let offset = 0;
      return {
        readBytes(length: number) {
          io.readLengths.push(length);
          if (io.readError) throw new Error("Read denied");
          const bytes = io.bytes.slice(offset, offset + length);
          offset += bytes.byteLength;
          return bytes;
        },
        close: io.close,
      };
    }
    create() {
      io.files.set(this.uri, new Uint8Array());
    }
    write(value: Uint8Array | string) {
      io.files.set(this.uri, typeof value === "string" ? new TextEncoder().encode(value) : value);
      if (this.name === "package.json") io.afterWrite?.();
    }
  }
  return {
    File,
    Directory,
    FileMode: { ReadOnly: "r" },
    Paths: { cache: { uri: "file:///cache" } },
  };
});

import {
  BOT_PACKAGE_SHARE_MAX_BYTES,
  BOT_PACKAGE_SHARE_MAX_FILES,
  BOT_PACKAGE_SHARE_TTL_MS,
  BotPackageFileError,
  pickBotPackageFile,
  shareBotPackageFile,
} from "./bot-package-file";

const chosen = (size?: number) => ({
  canceled: false,
  assets: [{ uri: "file:///picked/package.json", name: "package.json", size }],
});
const NOW = 1_800_000_000_000;
const ROOT = "file:///cache/bot-package-shares-v1";
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  io.pick.mockReset().mockResolvedValue(chosen());
  io.available.mockReset().mockResolvedValue(true);
  io.share.mockReset().mockResolvedValue(undefined);
  io.bytes = new TextEncoder().encode('{"name":"Research 🐦","instructions":"first\\nsecond"}');
  io.infoSize = undefined;
  io.inputInfo.mockReset();
  io.openError = false;
  io.readError = false;
  io.cleanupError = false;
  io.readLengths = [];
  io.close.mockReset();
  io.afterWrite = undefined;
  io.infoSizes.clear();
  io.directories.clear();
  io.files.clear();
  io.created = [];
  io.deleted = [];
});
afterEach(() => vi.restoreAllMocks());

it.each(["file:///picked/package.json", "content://documents/package"])(
  "uses one native picker and preserves actual UTF-8 bytes from %s",
  async (uri) => {
    io.pick.mockResolvedValueOnce({ canceled: false, assets: [{ uri }] });
    const text = await pickBotPackageFile(() => true);
    expect(io.pick).toHaveBeenCalledExactlyOnceWith({
      multiple: false,
      copyToCacheDirectory: false,
      type: ["application/json", "text/plain"],
    });
    expect(text).toBe(new TextDecoder().decode(io.bytes));
    expect(io.close).toHaveBeenCalledOnce();
    expect(io.readLengths.every((length) => length <= 64 * 1024)).toBe(true);
  },
);

it("treats picker cancellation as no source and never reads a file", async () => {
  io.pick.mockResolvedValueOnce({ canceled: true, assets: null });
  expect(await pickBotPackageFile(() => true)).toBeNull();
  expect(io.readLengths).toEqual([]);
});

it("rejects a known oversized picker size before reading", async () => {
  io.pick.mockResolvedValueOnce(chosen(BOT_PACKAGE_MAX_BYTES + 1));
  await expect(pickBotPackageFile(() => true)).rejects.toMatchObject({ code: "too_large" });
  expect(io.readLengths).toEqual([]);
});

it("reads unknown-size input without consulting provider metadata", async () => {
  io.pick.mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: "content://documents/package" }],
  });
  io.inputInfo.mockImplementation(() => {
    throw new Error("Metadata lookup may materialize the full provider stream");
  });
  expect(await pickBotPackageFile(() => true)).toBe(new TextDecoder().decode(io.bytes));
  expect(io.inputInfo).not.toHaveBeenCalled();
  expect(io.close).toHaveBeenCalledOnce();
});

it("rejects an unknown-size stream after reading only MAX+1 bytes", async () => {
  io.bytes = new Uint8Array(BOT_PACKAGE_MAX_BYTES + 20).fill(0x20);
  await expect(pickBotPackageFile(() => true)).rejects.toMatchObject({ code: "too_large" });
  expect(io.inputInfo).not.toHaveBeenCalled();
  expect(io.readLengths.reduce((sum, length) => sum + length, 0)).toBe(BOT_PACKAGE_MAX_BYTES + 1);
  expect(io.close).toHaveBeenCalledOnce();
});

it("fails unsupported read-only providers without copying or whole-file fallback", async () => {
  io.pick.mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: "content://documents/package" }],
  });
  io.openError = true;
  await expect(pickBotPackageFile(() => true)).rejects.toMatchObject({ code: "read_failed" });
  expect(io.inputInfo).not.toHaveBeenCalled();
  expect(io.readLengths).toEqual([]);
  expect(io.created).toEqual([]);
  expect(io.close).not.toHaveBeenCalled();
  expect(io.pick).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: false }));
});

it("enforces the actual byte limit even when the declared size is false", async () => {
  io.pick.mockResolvedValueOnce(chosen(1));
  io.infoSize = 1;
  io.bytes = new Uint8Array(BOT_PACKAGE_MAX_BYTES + 20).fill(0x20);
  await expect(pickBotPackageFile(() => true)).rejects.toMatchObject({ code: "too_large" });
  expect(io.readLengths.reduce((sum, length) => sum + length, 0)).toBe(BOT_PACKAGE_MAX_BYTES + 1);
  expect(io.close).toHaveBeenCalledOnce();
});

it("accepts exactly the byte limit with missing file size", async () => {
  io.bytes = new Uint8Array(BOT_PACKAGE_MAX_BYTES).fill(0x20);
  const text = await pickBotPackageFile(() => true);
  expect(text).toHaveLength(BOT_PACKAGE_MAX_BYTES);
  expect(io.close).toHaveBeenCalledOnce();
});

it("rejects malformed UTF-8 rather than silently replacing source bytes", async () => {
  io.bytes = new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]);
  await expect(pickBotPackageFile(() => true)).rejects.toMatchObject({ code: "invalid_utf8" });
  expect(io.close).toHaveBeenCalledOnce();
});

it("closes the file handle when a read fails", async () => {
  io.readError = true;
  await expect(pickBotPackageFile(() => true)).rejects.toMatchObject({ code: "read_failed" });
  expect(io.close).toHaveBeenCalledOnce();
});

it("does not open a picker for a stale scope", async () => {
  await expect(pickBotPackageFile(() => false)).rejects.toMatchObject({ code: "scope_changed" });
  expect(io.pick).not.toHaveBeenCalled();
});

it("rejects a returned picker after an account/Space generation change", async () => {
  let generation = 1;
  let release!: (value: ReturnType<typeof chosen>) => void;
  io.pick.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
  const pending = pickBotPackageFile(() => generation === 1);
  generation = 3;
  release(chosen());
  await expect(pending).rejects.toMatchObject({ code: "scope_changed" });
  expect(io.readLengths).toEqual([]);
});

it("discards a local file read when its request scope changes before publication", async () => {
  let current = true;
  const pending = pickBotPackageFile(() => current);
  await Promise.resolve();
  current = false;
  await expect(pending).rejects.toMatchObject({ code: "scope_changed" });
  expect(io.close).toHaveBeenCalledOnce();
});

it.each([
  { canceled: false, assets: [] },
  { canceled: false, assets: [{ uri: "https://example.test/package.json" }] },
  { canceled: false, assets: [chosen().assets[0], chosen().assets[0]] },
])("rejects invalid picker receipts without fetching or reading ($assets)", async (receipt) => {
  io.pick.mockResolvedValueOnce(receipt);
  await expect(pickBotPackageFile(() => true)).rejects.toMatchObject({ code: "read_failed" });
  expect(io.readLengths).toEqual([]);
});

function seedExport(at: number, index = 0, size = 2): string {
  io.directories.add(ROOT);
  const directory = `${ROOT}/${at}-aaaaaaaa${index}`;
  io.directories.add(directory);
  io.files.set(`${directory}/package.json`, new Uint8Array(size));
  io.files.set(
    `${directory}/retention.json`,
    new TextEncoder().encode(JSON.stringify({ version: 1, retainedAt: at })),
  );
  return directory;
}
function exportDirectories() {
  return [...io.directories].filter((path) => path.startsWith(`${ROOT}/`));
}

it("hands off JSON under a one-use anonymous path and retains the file for delayed readers", async () => {
  const foreign = "file:///cache/unrelated/data.json";
  io.directories.add("file:///cache/unrelated");
  io.files.set(foreign, new Uint8Array([1]));
  const text = '{"format":"coginebot.package/v1","instructions":"保留\\n"}';
  io.share.mockImplementationOnce(async (uri: string, options: { mimeType: string }) => {
    expect(options).toEqual({ mimeType: "application/json" });
    expect(uri).toMatch(/^file:\/\/\/cache\/bot-package-shares-v1\/\d{13}-[\w-]+\/package.json$/);
    expect(new TextDecoder().decode(io.files.get(uri))).toBe(text);
    expect(io.deleted).toEqual([]);
  });
  await shareBotPackageFile(text, () => true);
  const path = io.share.mock.calls[0]![0] as string;
  expect(io.files.has(path)).toBe(true);
  expect(new TextDecoder().decode(io.files.get(path))).toBe(text);
  expect(io.files.has(foreign)).toBe(true);
  expect(exportDirectories()).toHaveLength(1);
  expect(io.deleted).toEqual([]);
});

it("does not create or share a file when the scope is already stale", async () => {
  await expect(shareBotPackageFile("{}", () => false)).rejects.toMatchObject({
    code: "scope_changed",
  });
  expect(io.available).not.toHaveBeenCalled();
  expect(io.created).toEqual([]);
  expect(io.share).not.toHaveBeenCalled();
});

it("does not write a file after scope changes while checking share support", async () => {
  let current = true;
  io.available.mockImplementationOnce(async () => {
    current = false;
    return true;
  });
  await expect(shareBotPackageFile("{}", () => current)).rejects.toMatchObject({
    code: "scope_changed",
  });
  expect(io.created).toEqual([]);
  expect(io.share).not.toHaveBeenCalled();
});

it("removes a fresh reservation if its scope expires before OS handoff", async () => {
  let current = true;
  io.afterWrite = () => {
    current = false;
  };
  await expect(shareBotPackageFile("{}", () => current)).rejects.toMatchObject({
    code: "scope_changed",
  });
  expect(io.share).not.toHaveBeenCalled();
  expect(exportDirectories()).toHaveLength(0);
  expect(io.files.size).toBe(0);
});

it("reports unavailable native sharing without leaving a cache export", async () => {
  io.available.mockResolvedValueOnce(false);
  await expect(shareBotPackageFile("{}", () => true)).rejects.toMatchObject({
    code: "sharing_unavailable",
  });
  expect(io.created).toEqual([]);
  expect(io.share).not.toHaveBeenCalled();
});

it("reports a failed share availability check before creating an export", async () => {
  io.available.mockRejectedValueOnce(new Error("Unavailable"));
  await expect(shareBotPackageFile("{}", () => true)).rejects.toMatchObject({
    code: "share_failed",
  });
  expect(io.created).toEqual([]);
});

it("checks the actual UTF-8 export size before creating any file", async () => {
  const text = "界".repeat(Math.ceil(BOT_PACKAGE_MAX_BYTES / 3));
  await expect(shareBotPackageFile(text, () => true)).rejects.toMatchObject({
    code: "too_large",
  });
  expect(io.created).toEqual([]);
  expect(io.available).not.toHaveBeenCalled();
});

it("rejects an export string that cannot round-trip through UTF-8", async () => {
  await expect(shareBotPackageFile("\ud800", () => true)).rejects.toMatchObject({
    code: "invalid_utf8",
  });
  expect(io.created).toEqual([]);
  expect(io.available).not.toHaveBeenCalled();
});

it("retains a possibly handed-off file even when the native share promise rejects", async () => {
  const previous = seedExport(NOW - 100);
  io.share.mockRejectedValueOnce(new Error("No target"));
  await expect(shareBotPackageFile("{}", () => true)).rejects.toMatchObject({
    code: "share_failed",
  });
  expect(exportDirectories()).toHaveLength(2);
  expect(io.files.has(`${previous}/package.json`)).toBe(true);
  const path = io.share.mock.calls[0]![0] as string;
  expect(io.files.has(path)).toBe(true);
  expect(io.deleted).toEqual([]);
});

it("serializes reservations so overlapping exports cannot exceed the ten-file cap", async () => {
  for (let i = 0; i < BOT_PACKAGE_SHARE_MAX_FILES - 1; i++) seedExport(NOW - 100, i);
  const results = await Promise.allSettled([
    shareBotPackageFile('{"name":"First"}', () => true),
    shareBotPackageFile('{"name":"Second"}', () => true),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "cache_full" },
  });
  expect(io.share).toHaveBeenCalledOnce();
  expect(exportDirectories()).toHaveLength(BOT_PACKAGE_SHARE_MAX_FILES);
});

it("never evicts fresh exports to make room for another", async () => {
  for (let i = 0; i < BOT_PACKAGE_SHARE_MAX_FILES; i++) seedExport(NOW - 100, i);
  await expect(shareBotPackageFile("{}", () => true)).rejects.toMatchObject({ code: "cache_full" });
  expect(io.share).not.toHaveBeenCalled();
  expect(io.deleted).toEqual([]);
  expect(exportDirectories()).toHaveLength(BOT_PACKAGE_SHARE_MAX_FILES);
});

it("keeps the cache cap effective even after the device clock resets near the epoch", async () => {
  vi.mocked(Date.now).mockReturnValue(0);
  for (let i = 0; i < BOT_PACKAGE_SHARE_MAX_FILES; i++) seedExport(0, i);
  await expect(shareBotPackageFile("{}", () => true)).rejects.toMatchObject({ code: "cache_full" });
  expect(io.share).not.toHaveBeenCalled();
});

it("also bounds aggregate retained package bytes", async () => {
  const previous = seedExport(NOW - 100);
  io.infoSizes.set(`${previous}/package.json`, BOT_PACKAGE_SHARE_MAX_BYTES - 1);
  await expect(shareBotPackageFile("{}", () => true)).rejects.toMatchObject({ code: "cache_full" });
  expect(io.share).not.toHaveBeenCalled();
  expect(io.deleted).toEqual([]);
});

it("lazily cleans only expired controlled exports on a new share", async () => {
  const expired = seedExport(NOW - BOT_PACKAGE_SHARE_TTL_MS);
  const fresh = seedExport(NOW - 1);
  const unrelated = `${ROOT}/unrelated`;
  io.directories.add(unrelated);
  io.files.set(`${unrelated}/private.txt`, new Uint8Array([1]));
  await shareBotPackageFile("{}", () => true);
  expect(io.deleted).toEqual([expired]);
  expect(io.files.has(`${fresh}/package.json`)).toBe(true);
  expect(io.files.has(`${unrelated}/private.txt`)).toBe(true);
});

it("keeps an old active share while another export prunes expired entries", async () => {
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  io.share.mockImplementationOnce(() => {
    began();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const first = shareBotPackageFile('{"name":"First"}', () => true);
  await started;
  const firstPath = io.share.mock.calls[0]![0] as string;
  vi.mocked(Date.now).mockReturnValue(NOW + BOT_PACKAGE_SHARE_TTL_MS + 1);
  await shareBotPackageFile('{"name":"Second"}', () => true);
  expect(io.files.has(firstPath)).toBe(true);
  release();
  await first;
  expect(exportDirectories()).toHaveLength(2);
  const retained = JSON.parse(
    new TextDecoder().decode(io.files.get(firstPath.replace("package.json", "retention.json"))),
  );
  expect(retained.retainedAt).toBe(NOW + BOT_PACKAGE_SHARE_TTL_MS + 1);
});

it("does not delete uncertain retention metadata even if its directory name looks old", async () => {
  const directory = seedExport(NOW - BOT_PACKAGE_SHARE_TTL_MS - 1);
  io.files.set(`${directory}/retention.json`, new TextEncoder().encode("not JSON"));
  await shareBotPackageFile("{}", () => true);
  expect(io.files.has(`${directory}/package.json`)).toBe(true);
  expect(io.deleted).toEqual([]);
});

it("retains a handed-off file after scope changes without claiming a current completion", async () => {
  let current = true;
  io.share.mockImplementationOnce(async () => {
    current = false;
  });
  await expect(shareBotPackageFile("{}", () => current)).rejects.toMatchObject({
    code: "scope_changed",
  });
  const path = io.share.mock.calls[0]![0] as string;
  expect(io.files.has(path)).toBe(true);
  expect(io.deleted).toEqual([]);
});

it("reports cleanup failure instead of claiming a rejected export was removed", async () => {
  let current = true;
  io.cleanupError = true;
  io.afterWrite = () => {
    current = false;
  };
  await expect(shareBotPackageFile("{}", () => current)).rejects.toMatchObject({
    code: "cleanup_failed",
  });
  expect(io.share).not.toHaveBeenCalled();
});

it("uses typed file errors without embedding local file paths or user data", async () => {
  io.readError = true;
  const error = await pickBotPackageFile(() => true).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(BotPackageFileError);
  expect((error as Error).message).toBe("read_failed");
});
