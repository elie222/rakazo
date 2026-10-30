import { resolveComposerSendPlan } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";
import { OUTBOX_MAX_BYTES, outboxDisk } from "./outbox-disk";
import type { SendAttempt } from "./thread-feedback";
import { OUTBOX_MAX_ENTRIES } from "./thread-feedback";

const files = vi.hoisted(() => new Map<string, string>());
const disk = vi.hoisted(() => ({
  /** Every write throws, like a full device. */
  full: false,
  /**
   * The next `operation:file name` step throws, e.g. `move:sends-v4.json`. Android-style moves
   * that fall back to a copy: `partial:<destination>` leaves part of the copy behind because its
   * cleanup fails too, and `keep-source:<source>` copies fully, then fails to delete the source.
   */
  failAt: undefined as string | undefined,
}));
function fails(operation: string, uri: string) {
  if (disk.full && operation === "write") return true;
  if (disk.failAt !== `${operation}:${uri.split("/").pop()}`) return false;
  disk.failAt = undefined;
  return true;
}
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return [...files.keys()].some((p) => p.startsWith(this.uri));
    }
    create() {}
    delete() {
      for (const path of files.keys()) if (path.startsWith(`${this.uri}/`)) files.delete(path);
    }
    list() {
      const names = new Set(
        [...files.keys()]
          .filter((path) => path.startsWith(`${this.uri}/`))
          .map((path) => path.slice(this.uri.length + 1).split("/")[0]!),
      );
      return [...names].map((name) =>
        files.has(`${this.uri}/${name}`) ? new File(this, name) : new Directory(this, name),
      );
    }
  }
  class File extends Directory {
    override get exists() {
      return files.has(this.uri);
    }
    get size() {
      return Buffer.byteLength(files.get(this.uri) ?? "");
    }
    async base64() {
      return files.get(this.uri) ?? "";
    }
    textSync() {
      if (fails("read", this.uri)) throw new Error("Read failed");
      return files.get(this.uri);
    }
    // Like the device, creating over an existing file empties it before any write.
    override create(options?: { overwrite?: boolean }) {
      if (this.exists && !options?.overwrite) throw new Error("File exists");
      if (fails("create", this.uri)) throw new Error("Create failed");
      files.set(this.uri, "");
    }
    override delete() {
      if (fails("delete", this.uri)) throw new Error("Delete failed");
      files.delete(this.uri);
    }
    write(text: string) {
      if (fails("write", this.uri)) throw new Error("No space left on device");
      files.set(this.uri, text);
    }
    // Like the device, overwriting deletes the destination before the move itself, and a move
    // points the source object at the destination.
    moveSync(destination: File, options?: { overwrite?: boolean }) {
      if (destination.exists && !options?.overwrite) throw new Error("Destination exists");
      files.delete(destination.uri);
      if (fails("move", destination.uri)) throw new Error("Move failed");
      const text = files.get(this.uri)!;
      if (fails("partial", destination.uri)) {
        files.set(destination.uri, text.slice(0, text.length / 2));
        throw new Error("Copy failed");
      }
      files.set(destination.uri, text);
      if (fails("keep-source", this.uri)) throw new Error("Failed to delete source after move");
      files.delete(this.uri);
      this.uri = destination.uri;
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});
const scope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  cacheSession: "namespace-a",
  spaceId: "space-a",
};
function attempt(nonce = "nonce-a"): SendAttempt {
  return {
    ...scope,
    state: "pending",
    session: 1,
    clientNonce: nonce,
    artifactIds: new Map([["attachment-a", "artifact-a"]]),
    payload: {
      originThreadKey: "bot-a",
      displayText: "Hello",
      replyPreview: null,
      botTarget: "bot-a",
      reroutedToGroup: false,
      plan: resolveComposerSendPlan({ text: "Hello", mentions: [], hasAttachments: true }),
      replyQuote: null,
      attachments: [
        {
          id: "attachment-a",
          name: "photo.png",
          mimeType: "image/png",
          contentBase64: "aGVsbG8=",
          previewUri: "file:///fake-preview",
        },
      ],
    },
  };
}
beforeEach(() => {
  files.clear();
  disk.full = false;
  disk.failAt = undefined;
});
it("restores payload, uploaded ids and nonce for an idempotent retry", async () => {
  const original = attempt();
  expect(outboxDisk.admit(original)).toBe(true);
  outboxDisk.save([original]);
  files.set("cache/outbox/delivered/0", "orphan");
  const [restored] = outboxDisk.load(2, scope);
  expect(restored).toMatchObject({
    state: "queued",
    session: 2,
    clientNonce: original.clientNonce,
  });
  expect(files.has("cache/outbox/delivered/0")).toBe(false);
  expect(restored?.artifactIds).toEqual(original.artifactIds);
  expect(restored?.payload.attachments[0]?.contentBase64).toBe("");
  restored!.artifactIds.clear();
  await outboxDisk.hydrate(restored!);
  expect(restored?.payload.attachments[0]?.contentBase64).toBe("aGVsbG8=");
  const metadata = files.get("cache/outbox/sends-v4.json");
  expect(metadata).not.toContain("aGVsbG8=");
  expect(metadata).not.toContain("file:");
});
it.each([
  { userId: "user-b" },
  { apiBase: "https://other.example.test" },
  { cacheSession: "namespace-b" },
])("rejects a different owner or session %j", (change) => {
  outboxDisk.save([attempt()]);
  expect(outboxDisk.load(2, { ...scope, ...change })).toEqual([]);
});
it("caps the persisted count and wipes every entry", () => {
  outboxDisk.save(Array.from({ length: OUTBOX_MAX_ENTRIES + 5 }, (_, i) => attempt(`nonce-${i}`)));
  expect(outboxDisk.load(2, scope)).toHaveLength(OUTBOX_MAX_ENTRIES);
  outboxDisk.clear();
  expect(files.size).toBe(0);
});
it("treats corrupt storage as an empty outbox", () => {
  files.set("cache/outbox/sends-v4.json", "{");
  expect(outboxDisk.load(2, scope)).toEqual([]);
});

it("rejects a full attachment budget without rewriting existing bytes", () => {
  files.set("cache/outbox/old/0", "x");
  const large = attempt();
  large.payload.attachments[0]!.contentBase64 = "x".repeat(Math.ceil((OUTBOX_MAX_BYTES * 4) / 3));
  expect(outboxDisk.admit(large)).toBe(false);
  expect(files.get("cache/outbox/old/0")).toBe("x");
});

it("does not reuse leftover bytes for a repeated nonce in another session", () => {
  files.set("cache/outbox/nonce-a/0", "old-private-placeholder");
  const next = { ...attempt(), userId: "user-b", cacheSession: "namespace-b" };
  expect(outboxDisk.admit(next)).toBe(false);
  expect(next.payload.attachments[0]?.contentBase64).toBe("aGVsbG8=");
});

function saved(...nonces: string[]) {
  const attempts = nonces.map((nonce) => attempt(nonce));
  for (const a of attempts) outboxDisk.admit(a);
  outboxDisk.save(attempts);
  return attempts;
}
function stored() {
  return [...files.keys()].sort();
}

it("keeps the earlier queue when a later index write fails", () => {
  const [first] = saved("nonce-a");
  disk.full = true;
  expect(() => outboxDisk.save([first!, attempt("nonce-b")])).toThrow();
  disk.full = false;
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
  expect(files.has("cache/outbox/nonce-a/0")).toBe(true);
});

it.each([
  "create:sends-v4.json.tmp",
  "write:sends-v4.json.tmp",
  "move:sends-v4.json.bak",
  "move:sends-v4.json",
])("restores the last committed queue, not the failed one, when a save stops at %s", (step) => {
  const [first] = saved("nonce-a");
  const committed = files.get("cache/outbox/sends-v4.json");
  const rejected = attempt("nonce-b");
  outboxDisk.admit(rejected);
  disk.failAt = step;
  expect(() => outboxDisk.save([first!, rejected])).toThrow();
  outboxDisk.forget(rejected);
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
  expect(files.get("cache/outbox/sends-v4.json")).toBe(committed);
  expect(stored()).toEqual(["cache/outbox/nonce-a/0", "cache/outbox/sends-v4.json"]);
});

it("keeps the restored queue when the first save after an interrupted swap fails", () => {
  const [first] = saved("nonce-a");
  disk.failAt = "move:sends-v4.json";
  expect(() => outboxDisk.save([first!, attempt("nonce-b")])).toThrow();
  const restored = outboxDisk.load(2, scope);
  disk.full = true;
  expect(() => outboxDisk.save(restored)).toThrow();
  disk.full = false;
  expect(outboxDisk.load(3, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
  expect(files.has("cache/outbox/nonce-a/0")).toBe(true);
});

it("counts a save as committed when the new index is in place but its replacement stays", async () => {
  const [first] = saved("nonce-a");
  const second = attempt("nonce-b");
  outboxDisk.admit(second);
  disk.failAt = "keep-source:sends-v4.json.tmp";
  // Like sendAttempt(), delete the files of a message whose save failed.
  try {
    outboxDisk.save([first!, second]);
  } catch {
    outboxDisk.forget(second);
  }
  expect(files.has("cache/outbox/sends-v4.json.tmp")).toBe(false);
  const restored = outboxDisk.load(2, scope);
  expect(restored.map((a) => a.clientNonce)).toEqual(["nonce-a", "nonce-b"]);
  for (const a of restored) {
    a.artifactIds.clear();
    await outboxDisk.hydrate(a);
  }
  expect(stored()).toEqual([
    "cache/outbox/nonce-a/0",
    "cache/outbox/nonce-b/0",
    "cache/outbox/sends-v4.json",
  ]);
});

it("does not set a partial index aside over the last committed one", () => {
  const [first] = saved("nonce-a");
  disk.failAt = "partial:sends-v4.json";
  expect(() => outboxDisk.save([first!, attempt("nonce-b")])).toThrow();
  disk.failAt = "move:sends-v4.json";
  expect(() => outboxDisk.save([first!, attempt("nonce-c")])).toThrow();
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
  expect(files.has("cache/outbox/nonce-a/0")).toBe(true);
});

it("keeps saving after earlier saves, and keeps the last one when a later save fails", () => {
  const [first, second] = saved("nonce-a", "nonce-b");
  outboxDisk.save([first!]);
  outboxDisk.save([first!, second!]);
  disk.full = true;
  expect(() => outboxDisk.save([second!])).toThrow();
  disk.full = false;
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a", "nonce-b"]);
});

it("counts a save as committed when its backup cannot be deleted", () => {
  const [, second] = saved("nonce-a", "nonce-b");
  disk.failAt = "delete:sends-v4.json.bak";
  outboxDisk.save([second!]);
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-b"]);
  expect(stored()).toEqual(["cache/outbox/nonce-b/0", "cache/outbox/sends-v4.json"]);
});

it.each(["sends-v4.json.tmp", "sends-v4.json.bak"])(
  "keeps a full queue when an interrupted save left %s next to it",
  (leftover) => {
    saved("nonce-a");
    const index = files.get("cache/outbox/sends-v4.json")!;
    files.set("cache/outbox/nonce-a/0", "x".repeat(OUTBOX_MAX_BYTES - Buffer.byteLength(index)));
    files.set(`cache/outbox/${leftover}`, index);
    expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
    expect(stored()).toEqual(["cache/outbox/nonce-a/0", "cache/outbox/sends-v4.json"]);
  },
);

it("keeps the queue on disk when reading it fails, so a later load retries", () => {
  saved("nonce-a");
  const before = stored();
  disk.failAt = "read:sends-v4.json";
  expect(() => outboxDisk.load(2, scope)).toThrow();
  expect(stored()).toEqual(before);
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
});
