import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  CloudAgentHomeStore,
  CloudArtifactStore,
  type CloudObjects,
  cloudHomePath,
} from "./cloud-storage.js";

class Objects implements CloudObjects {
  rows = new Map<string, { bytes: Uint8Array; etag: string }>();
  async get(key: string) {
    return this.rows.get(key) ?? null;
  }
  async put(key: string, bytes: Uint8Array, condition?: { etag?: string; absent?: boolean }) {
    const row = this.rows.get(key);
    if ((condition?.absent && row) || (condition?.etag && condition.etag !== row?.etag)) {
      const e = new Error("conflict");
      e.name = "PreconditionFailed";
      throw e;
    }
    this.rows.set(key, { bytes: bytes.slice(), etag: randomUUID() });
  }
  async remove(key: string) {
    this.rows.delete(key);
  }
}
const ctx: AdapterContext = {
  spaceId: "space-a",
  userId: "user-a",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
describe("cloud storage", () => {
  it("isolates tenant artifacts and verifies their hashes", async () => {
    const objects = new Objects();
    const artifacts = new CloudArtifactStore(objects);
    const value = await artifacts.put(
      { bytes: Buffer.from("hello"), mimeType: "text/plain", name: "hello.txt" },
      ctx,
    );
    expect(value.hash).toHaveLength(64);
    expect(Buffer.from(await artifacts.get(value.id, ctx)).toString()).toBe("hello");
    await expect(artifacts.get(value.id, { ...ctx, spaceId: "space-b" })).rejects.toThrow(
      "not found",
    );
  });
  it("merges concurrent writes across independent processes and preserves revisions", async () => {
    const objects = new Objects();
    const one = new CloudAgentHomeStore(objects);
    const two = new CloudAgentHomeStore(objects);
    await Promise.all([
      one.writeFile("bot", "a.txt", "a", ctx),
      two.writeFile("bot", "b.txt", "b", ctx),
    ]);
    expect((await one.list("bot", "", ctx)).map((e) => e.path).sort()).toEqual(["a.txt", "b.txt"]);
    const dest = await mkdtemp(path.join(tmpdir(), "cloud-home-test-"));
    try {
      const revision = await one.checkout("bot", dest, ctx);
      await two.writeFile("bot", "a.txt", "new", ctx);
      await one.restore("bot", revision, dest, ctx);
      expect(await readFile(path.join(dest, "a.txt"), "utf8")).toBe("a");
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });
  it("refuses corrupt content and traversal paths", async () => {
    const objects = new Objects();
    const home = new CloudAgentHomeStore(objects);
    await home.writeFile("bot", "a.txt", "original", ctx);
    const key = [...objects.rows.keys()].find((k) => k.includes("/blobs/"))!;
    objects.rows.get(key)!.bytes = Buffer.from("tampered");
    await expect(home.readFile("bot", "a.txt", ctx)).rejects.toThrow("integrity");
    for (const name of ["../x", "/x", "a/../b", "a\\b", "a//b"])
      expect(() => cloudHomePath(name)).toThrow();
  });
  it("does not follow a symlink out of a checkout", async () => {
    const objects = new Objects();
    const home = new CloudAgentHomeStore(objects);
    await home.writeFile("bot", "escape/a.txt", "secret", ctx);
    const dest = await mkdtemp(path.join(tmpdir(), "cloud-safe-"));
    const outside = await mkdtemp(path.join(tmpdir(), "cloud-outside-"));
    try {
      await symlink(outside, path.join(dest, "escape"));
      await expect(home.checkout("bot", dest, ctx)).rejects.toThrow("escapes");
      await expect(readFile(path.join(outside, "a.txt"))).rejects.toThrow();
    } finally {
      await rm(dest, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
