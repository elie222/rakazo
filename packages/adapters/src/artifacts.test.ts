import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "./artifacts.js";

const dirs: string[] = [];
const context = { spaceId: "space-1" } as never;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LocalArtifactStore", () => {
  it("creates artifact files with owner-only permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const store = new LocalArtifactStore(root);

    const stored = await store.put(
      { name: "private.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("private") },
      context,
    );

    const info = await stat(path.join(root, "artifacts", "space-1", stored.id));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("does not follow a replacement symlink when reading an artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const store = new LocalArtifactStore(root);
    const stored = await store.put(
      { name: "private.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("private") },
      context,
    );
    const file = path.join(root, "artifacts", "space-1", stored.id);
    const target = path.join(root, "outside.txt");
    await writeFile(target, "outside");
    await rm(file);
    await symlink(target, file);

    await expect(store.get(stored.id, context)).rejects.toThrow();
  });
});

it.each(["../outside", "/etc/passwd", "https://example.test/audio", "a/b", "a\\b", ".."])(
  "rejects non-opaque artifact paths: %s",
  async (id) => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const store = new LocalArtifactStore(root);
    await expect(store.get(id, context)).rejects.toThrow("storage reference");
  },
);

it("bounds artifact reads and rejects a symlinked space directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
  dirs.push(root);
  const store = new LocalArtifactStore(root);
  const stored = await store.put(
    { name: "private.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("private") },
    context,
  );
  await expect(store.get(stored.id, context, { maxBytes: 6 })).rejects.toThrow("byte limit");
  expect(await store.get(stored.id, context, { maxBytes: 7 })).toEqual(
    new TextEncoder().encode("private"),
  );
  const directory = path.join(root, "artifacts", "space-1");
  await rm(directory, { recursive: true });
  await symlink(root, directory);
  await expect(store.get(stored.id, context)).rejects.toThrow("storage directory");
});

it("removes missing artifacts idempotently, including missing scope directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
  dirs.push(root);
  const store = new LocalArtifactStore(root);
  await expect(store.remove("missing", context)).resolves.toBeUndefined();
  await mkdir(path.join(root, "artifacts"));
  await expect(store.remove("missing", context)).resolves.toBeUndefined();
  const stored = await store.put(
    { name: "file.txt", mimeType: "text/plain", bytes: new Uint8Array([1]) },
    context,
  );
  await store.remove(stored.id, context);
  await expect(store.remove(stored.id, context)).resolves.toBeUndefined();
  await rm(root, { recursive: true });
  await expect(store.remove("missing", context)).resolves.toBeUndefined();
});

it("still validates removal identifiers when directories are missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
  dirs.push(root);
  const store = new LocalArtifactStore(root);
  await expect(store.remove("../outside", context)).rejects.toThrow("storage reference");
  await expect(store.remove("missing", { spaceId: "../outside" } as never)).rejects.toThrow(
    "space reference",
  );
});

it.each(["artifacts", "artifacts/space-1"])(
  "does not hide redirected or dangling removal scope symlinks: %s",
  async (scope) => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const store = new LocalArtifactStore(root);
    const directory = path.join(root, scope);
    await mkdir(path.dirname(directory), { recursive: true });
    const target = path.join(root, "outside");
    await mkdir(target);
    await symlink(target, directory);
    await expect(store.remove("missing", context)).rejects.toThrow("storage directory");
    await rm(target, { recursive: true });
    await expect(store.remove("missing", context)).rejects.toThrow("storage directory");
  },
);

it("rejects a dangling configured root rather than hiding its symlink error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
  dirs.push(root);
  const link = path.join(root, "linked-root");
  await symlink(path.join(root, "missing"), link);
  await expect(new LocalArtifactStore(link).remove("missing", context)).rejects.toThrow(
    "storage directory",
  );
});
