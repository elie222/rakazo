import { resolveComposerSendPlan } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";
import { OUTBOX_MAX_BYTES, outboxDisk } from "./outbox-disk";
import type { SendAttempt } from "./thread-feedback";
import { OUTBOX_MAX_ENTRIES } from "./thread-feedback";

const files = vi.hoisted(() => new Map<string, string>());
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
      return files.get(this.uri);
    }
    write(text: string) {
      files.set(this.uri, text);
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
beforeEach(() => files.clear());
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
