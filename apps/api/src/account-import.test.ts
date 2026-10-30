import type { Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { AccountImportDeps, ArchiveEntry, ArchiveSink } from "./account-import.js";
import {
  ACCOUNT_IMPORT_LIMITS,
  AccountImportError,
  importAccount,
  parseEntryName,
  readArchive,
  remapIds,
} from "./account-import.js";
import { buildArchive, chunked, manifestFor } from "./account-import.test-support.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "ada@example.com",
  isDeploymentOwner: false,
};

/** Every rejection here must happen before anything is written. */
const untouched = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`dependency touched: ${String(property)}`);
    },
  },
);
const deps = {
  prisma: untouched,
  sandbox: untouched,
  home: untouched,
  jobs: untouched,
  artifacts: untouched,
  dataDir: "/nonexistent",
  maxArtifactBytes: 1024,
} as unknown as AccountImportDeps;

const importBytes = (bytes: Uint8Array) => importAccount(deps, actor, chunked(bytes));

class RecordingSink implements ArchiveSink {
  readonly files: Array<{ entry: ArchiveEntry; text: string }> = [];
  private chunks: Uint8Array[] = [];
  async open(entry: ArchiveEntry) {
    this.files.push({ entry, text: "" });
    this.chunks = [];
  }
  async write(chunk: Uint8Array) {
    this.chunks.push(chunk);
  }
  async close() {
    this.files.at(-1)!.text = Buffer.concat(this.chunks).toString("utf8");
  }
}

const limits = { ...ACCOUNT_IMPORT_LIMITS, artifactBytes: 1024 };

describe("account import archive", () => {
  it("rejects another format", async () => {
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify({ ...manifestFor([]), format: "other-export" })],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("not a readable Rakazo export");
  });

  it("rejects a newer version", async () => {
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify({ ...manifestFor([]), version: 2 })],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("newer version of Rakazo");
  });

  it("rejects an archive that does not start with the manifest", async () => {
    const bytes = buildArchive([
      ["spaces/s1/records.jsonl", ""],
      ["manifest.json", JSON.stringify(manifestFor([{ id: "s1", name: "Home" }]))],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("not a readable Rakazo export");
  });

  it("rejects bytes that are not a zip, and a truncated zip", async () => {
    await expect(importBytes(new TextEncoder().encode("hello"))).rejects.toThrow(
      "not a readable Rakazo export",
    );
    const name = Array.from({ length: 4000 }, (_, i) => i.toString(36)).join("");
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify(manifestFor([{ id: "s1", name }]))],
    ]);
    await expect(importBytes(bytes.subarray(0, bytes.byteLength / 2))).rejects.toThrow(
      "not a readable Rakazo export",
    );
  });

  it.each([
    "spaces/s1/homes/b1/../../../etc/passwd",
    "spaces/s1/homes/b1/./notes.md",
    "/etc/passwd",
    "spaces//records.jsonl",
    "spaces/s1/artifacts/a1/extra",
    "spaces/s1/homes/b1",
    "spaces/s1/homes/b1/dir\\..\\x",
    "other/s1/records.jsonl",
    "manifest.json",
  ])("rejects the entry name %s", (name) => {
    expect(() => parseEntryName(name, 1)).toThrow(AccountImportError);
  });

  it("parses the documented layout", () => {
    expect(parseEntryName("manifest.json", 0)).toEqual({ kind: "manifest" });
    expect(parseEntryName("spaces/s1/records.jsonl", 1)).toEqual({
      kind: "records",
      spaceId: "s1",
    });
    expect(parseEntryName("spaces/s1/artifacts/a1", 2)).toEqual({
      kind: "artifact",
      spaceId: "s1",
      artifactId: "a1",
    });
    expect(parseEntryName("spaces/s1/homes/b1/notes/today.md", 3)).toEqual({
      kind: "home",
      spaceId: "s1",
      botId: "b1",
      path: "notes/today.md",
    });
    expect(parseEntryName("spaces/s1/executables.json", 4)).toEqual({
      kind: "executables",
      spaceId: "s1",
    });
  });

  it("rejects path traversal in an archive before writing anything", async () => {
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify(manifestFor([{ id: "s1", name: "Home" }]))],
      ["spaces/s1/homes/b1/../../escape.sh", "echo"],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("unexpected file");
  });

  it("rejects an oversized manifest", async () => {
    const bytes = buildArchive([
      [
        "manifest.json",
        JSON.stringify({ ...manifestFor([]), padding: "x".repeat(2 * 1024 * 1024) }),
      ],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("too large");
  });

  it("stops an artifact over the artifact limit while inflating", async () => {
    const sink = new RecordingSink();
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", ""],
      ["spaces/s1/artifacts/a1", "x".repeat(1025)],
    ]);
    await expect(readArchive(chunked(bytes), limits, sink)).rejects.toThrow(
      "An artifact in the export exceeds",
    );
    expect(sink.files.at(-1)?.entry.kind).not.toBe("artifact");
  });

  it("stops a workspace file over the home file limit", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/homes/b1/big.bin", new Uint8Array(ACCOUNT_IMPORT_LIMITS.homeFileBytes + 1)],
    ]);
    await expect(
      readArchive(chunked(bytes, 64 * 1024), limits, new RecordingSink()),
    ).rejects.toThrow("A workspace file in the export exceeds");
  });

  it("stops a zip bomb at the unpacked limit", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "\n".repeat(4 * 1024 * 1024)],
    ]);
    await expect(
      readArchive(chunked(bytes), { ...limits, unpackedBytes: 1024 * 1024 }, new RecordingSink()),
    ).rejects.toThrow("too large");
  });

  it("hands every entry to the sink in order, empty ones included", async () => {
    const sink = new RecordingSink();
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "line\n".repeat(10_000)],
      ["spaces/s1/artifacts/a1", ""],
      ["spaces/s1/homes/b1/a.md", "hello"],
    ]);
    await readArchive(chunked(bytes, 333), limits, sink);
    expect(sink.files.map((file) => [file.entry.kind, file.text.length])).toEqual([
      ["manifest", 2],
      ["records", 50_000],
      ["artifact", 0],
      ["home", 5],
    ]);
  });
});

describe("remapIds", () => {
  it("replaces exact id strings anywhere in the blocks and nothing else", () => {
    const ids = new Map([
      ["old-artifact", "new-artifact"],
      ["old-bot", "new-bot"],
    ]);
    const blocks = [
      { kind: "text", text: "see old-artifact" },
      { kind: "artifact", artifactId: "old-artifact", meta: { by: ["old-bot", 3, null] } },
    ];
    expect(remapIds(blocks, ids)).toEqual([
      { kind: "text", text: "see old-artifact" },
      { kind: "artifact", artifactId: "new-artifact", meta: { by: ["new-bot", 3, null] } },
    ]);
  });
});
