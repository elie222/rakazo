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
   * Each `operation:path` step throws once; the path is a file name or its trailing segments, e.g.
   * `move:sends-v4.json` or `delete:cache/outbox`. Android-style moves that fall back to a copy:
   * `partial:<destination>` leaves part of the copy behind because its cleanup fails too, and
   * `keep-source:<source>` copies fully, then fails to delete the source. `partial-delete:<directory>`
   * deletes part of a directory, and `silent-create:<file>` returns without creating the file, as on iOS.
   * `skip:<directory>` makes a copy pass over that directory without an error, as Android does with
   * a directory it cannot list.
   */
  failAt: [] as string[],
}));
function fails(operation: string, uri: string) {
  if (disk.full && operation === "write") return true;
  const step = disk.failAt.findIndex((s) => {
    const [op, path] = s.split(/:(.*)/);
    return op === operation && (uri === path || uri.endsWith(`/${path}`));
  });
  if (step < 0) return false;
  disk.failAt.splice(step, 1);
  return true;
}
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((p) => (typeof p === "string" ? p : p.uri)).join("/");
    }
    get exists() {
      return [...files.keys()].some((p) => p.startsWith(`${this.uri}/`));
    }
    create() {}
    delete() {
      if (fails("delete", this.uri)) throw new Error("Delete failed");
      const paths = [...files.keys()].filter((path) => path.startsWith(`${this.uri}/`)).sort();
      const stop = fails("partial-delete", this.uri) ? paths.length / 2 : paths.length;
      for (const path of paths.slice(0, stop)) files.delete(path);
      if (stop < paths.length) throw new Error("Delete failed");
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
    // Like the device, a directory lands inside an existing destination, and Android copies file
    // by file, so a copy can stop partway.
    copySync(destination: Directory) {
      const target = destination.exists
        ? `${destination.uri}/${this.uri.split("/").pop()}`
        : destination.uri;
      const all = [...files.keys()].filter((path) => path.startsWith(`${this.uri}/`)).sort();
      const skipped = [...new Set(all.map((path) => path.slice(0, path.lastIndexOf("/"))))].filter(
        (directory) => fails("skip", directory),
      );
      const paths = all.filter((path) => !skipped.some((d) => path.startsWith(`${d}/`)));
      const stop = fails("partial", destination.uri) ? paths.length / 2 : paths.length;
      for (const path of paths.slice(0, stop))
        files.set(target + path.slice(this.uri.length), files.get(path)!);
      if (stop < paths.length) throw new Error("Copy failed");
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
      if (fails("silent-create", this.uri)) return;
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
  return { Directory, File, Paths: { cache: "cache", document: "document" } };
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
  disk.failAt = [];
});
it("restores payload, uploaded ids and nonce for an idempotent retry", async () => {
  const original = attempt();
  expect(outboxDisk.admit(original)).toBe(true);
  outboxDisk.save([original]);
  files.set("document/outbox/delivered/0", "orphan");
  const [restored] = outboxDisk.load(2, scope);
  expect(restored).toMatchObject({
    state: "queued",
    session: 2,
    clientNonce: original.clientNonce,
  });
  expect(files.has("document/outbox/delivered/0")).toBe(false);
  expect(restored?.artifactIds).toEqual(original.artifactIds);
  expect(restored?.payload.attachments[0]?.contentBase64).toBe("");
  restored!.artifactIds.clear();
  await outboxDisk.hydrate(restored!);
  expect(restored?.payload.attachments[0]?.contentBase64).toBe("aGVsbG8=");
  const metadata = files.get("document/outbox/sends-v4.json");
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
  files.set("document/outbox/sends-v4.json", "{");
  expect(outboxDisk.load(2, scope)).toEqual([]);
});

it("rejects a full attachment budget without rewriting existing bytes", () => {
  files.set("document/outbox/old/0", "x");
  const large = attempt();
  large.payload.attachments[0]!.contentBase64 = "x".repeat(Math.ceil((OUTBOX_MAX_BYTES * 4) / 3));
  expect(outboxDisk.admit(large)).toBe(false);
  expect(files.get("document/outbox/old/0")).toBe("x");
});

it("does not reuse leftover bytes for a repeated nonce in another session", () => {
  files.set("document/outbox/nonce-a/0", "old-private-placeholder");
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
  expect(files.has("document/outbox/nonce-a/0")).toBe(true);
});

it.each([
  "create:sends-v4.json.tmp",
  "write:sends-v4.json.tmp",
  "move:sends-v4.json.bak",
  "move:sends-v4.json",
])("restores the last committed queue, not the failed one, when a save stops at %s", (step) => {
  const [first] = saved("nonce-a");
  const committed = files.get("document/outbox/sends-v4.json");
  const rejected = attempt("nonce-b");
  outboxDisk.admit(rejected);
  disk.failAt = [step];
  expect(() => outboxDisk.save([first!, rejected])).toThrow();
  outboxDisk.forget(rejected);
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
  expect(files.get("document/outbox/sends-v4.json")).toBe(committed);
  expect(stored()).toEqual(["document/outbox/nonce-a/0", "document/outbox/sends-v4.json"]);
});

it("keeps the restored queue when the first save after an interrupted swap fails", () => {
  const [first] = saved("nonce-a");
  disk.failAt = ["move:sends-v4.json"];
  expect(() => outboxDisk.save([first!, attempt("nonce-b")])).toThrow();
  const restored = outboxDisk.load(2, scope);
  disk.full = true;
  expect(() => outboxDisk.save(restored)).toThrow();
  disk.full = false;
  expect(outboxDisk.load(3, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
  expect(files.has("document/outbox/nonce-a/0")).toBe(true);
});

it("counts a save as committed when the new index is in place but its replacement stays", async () => {
  const [first] = saved("nonce-a");
  const second = attempt("nonce-b");
  outboxDisk.admit(second);
  disk.failAt = ["keep-source:sends-v4.json.tmp"];
  // Like sendAttempt(), delete the files of a message whose save failed.
  try {
    outboxDisk.save([first!, second]);
  } catch {
    outboxDisk.forget(second);
  }
  expect(files.has("document/outbox/sends-v4.json.tmp")).toBe(false);
  const restored = outboxDisk.load(2, scope);
  expect(restored.map((a) => a.clientNonce)).toEqual(["nonce-a", "nonce-b"]);
  for (const a of restored) {
    a.artifactIds.clear();
    await outboxDisk.hydrate(a);
  }
  expect(stored()).toEqual([
    "document/outbox/nonce-a/0",
    "document/outbox/nonce-b/0",
    "document/outbox/sends-v4.json",
  ]);
});

it("does not set a partial index aside over the last committed one", () => {
  const [first] = saved("nonce-a");
  disk.failAt = ["partial:sends-v4.json"];
  expect(() => outboxDisk.save([first!, attempt("nonce-b")])).toThrow();
  disk.failAt = ["move:sends-v4.json"];
  expect(() => outboxDisk.save([first!, attempt("nonce-c")])).toThrow();
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
  expect(files.has("document/outbox/nonce-a/0")).toBe(true);
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
  disk.failAt = ["delete:sends-v4.json.bak"];
  outboxDisk.save([second!]);
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-b"]);
  expect(stored()).toEqual(["document/outbox/nonce-b/0", "document/outbox/sends-v4.json"]);
});

it.each(["sends-v4.json.tmp", "sends-v4.json.bak"])(
  "keeps a full queue when an interrupted save left %s next to it",
  (leftover) => {
    saved("nonce-a");
    const index = files.get("document/outbox/sends-v4.json")!;
    files.set("document/outbox/nonce-a/0", "x".repeat(OUTBOX_MAX_BYTES - Buffer.byteLength(index)));
    files.set(`document/outbox/${leftover}`, index);
    expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
    expect(stored()).toEqual(["document/outbox/nonce-a/0", "document/outbox/sends-v4.json"]);
  },
);

it("keeps the queue on disk when reading it fails, so a later load retries", () => {
  saved("nonce-a");
  const before = stored();
  disk.failAt = ["read:sends-v4.json"];
  expect(() => outboxDisk.load(2, scope)).toThrow();
  expect(stored()).toEqual(before);
  expect(outboxDisk.load(2, scope).map((a) => a.clientNonce)).toEqual(["nonce-a"]);
});

it("keeps the queue in documents, which the OS does not evict like the cache", () => {
  saved("nonce-a");
  expect(stored()).toEqual(["document/outbox/nonce-a/0", "document/outbox/sends-v4.json"]);
});

/** An outbox an earlier build left in the cache. */
function legacy(...nonces: string[]) {
  saved(...nonces);
  for (const [path, text] of [...files]) {
    files.delete(path);
    files.set(path.replace(/^document\//, "cache/"), text);
  }
}
function loaded() {
  return outboxDisk.load(2, scope).map((a) => a.clientNonce);
}

it("moves an earlier cache outbox to documents", async () => {
  legacy("nonce-a");
  const [restored] = outboxDisk.load(2, scope);
  expect(restored?.clientNonce).toBe("nonce-a");
  restored!.artifactIds.clear();
  await outboxDisk.hydrate(restored!);
  expect(restored?.payload.attachments[0]?.contentBase64).toBe("aGVsbG8=");
  expect(stored()).toEqual(["document/outbox/nonce-a/0", "document/outbox/sends-v4.json"]);
});

it("moves the cache outbox only once, even while its old copy cannot be deleted", () => {
  legacy("nonce-a", "nonce-b");
  disk.failAt = ["delete:cache/outbox"];
  const [, second] = outboxDisk.load(2, scope);
  outboxDisk.save([second!]);
  expect(loaded()).toEqual(["nonce-b"]);
  expect(stored()).toEqual(["document/outbox/nonce-b/0", "document/outbox/sends-v4.json"]);
});

it("copies again from the intact cache outbox when a copy stops partway", () => {
  legacy("nonce-a", "nonce-b");
  disk.failAt = ["partial:document/outbox"];
  expect(() => outboxDisk.load(2, scope)).toThrow();
  expect(files.has("cache/outbox/sends-v4.json")).toBe(true);
  expect(loaded()).toEqual(["nonce-a", "nonce-b"]);
  expect(stored()).toEqual([
    "document/outbox/nonce-a/0",
    "document/outbox/nonce-b/0",
    "document/outbox/sends-v4.json",
  ]);
});

it("keeps the cache outbox and blocks the restore when the copy cannot be marked complete", () => {
  legacy("nonce-a", "nonce-b");
  disk.failAt = ["silent-create:outbox-legacy-done", "partial-delete:cache/outbox"];
  expect(() => outboxDisk.load(2, scope)).toThrow();
  const [first, second] = outboxDisk.load(2, scope);
  const third = attempt("nonce-c");
  outboxDisk.admit(third);
  outboxDisk.save([first!, second!, third]);
  expect(loaded()).toEqual(["nonce-a", "nonce-b", "nonce-c"]);
  expect(files.has("document/outbox/nonce-c/0")).toBe(true);
});

it("copies again when the copy silently skipped an attachment folder", async () => {
  legacy("nonce-a", "nonce-b");
  disk.failAt = ["skip:cache/outbox/nonce-b"];
  expect(() => outboxDisk.load(2, scope)).toThrow();
  expect(files.has("cache/outbox/nonce-b/0")).toBe(true);
  const restored = outboxDisk.load(2, scope);
  expect(restored.map((a) => a.clientNonce)).toEqual(["nonce-a", "nonce-b"]);
  for (const a of restored) {
    a.artifactIds.clear();
    await outboxDisk.hydrate(a);
  }
  expect(files.has("cache/outbox/sends-v4.json")).toBe(false);
});

it("reports a clear that can neither mark nor delete the cache outbox", () => {
  legacy("nonce-a");
  disk.failAt = ["silent-create:outbox-legacy-done", "delete:cache/outbox"];
  expect(() => outboxDisk.clear()).toThrow();
});

it.each([
  ["after", true],
  ["before", false],
])("does not bring back cleared messages %s the cache outbox was moved", (_, moved) => {
  legacy("nonce-a");
  disk.failAt = ["delete:cache/outbox"];
  if (moved) outboxDisk.load(2, scope);
  disk.failAt = ["delete:cache/outbox"];
  outboxDisk.clear();
  expect(files.has("cache/outbox/sends-v4.json")).toBe(true);
  expect(loaded()).toEqual([]);
  expect(stored()).toEqual([]);
});
