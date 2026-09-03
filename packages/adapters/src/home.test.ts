import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-home-"));
  dirs.push(root);
  const store = new LocalAgentHomeStore(root);
  const home = store.pathFor("bot-1");
  await mkdir(home, { recursive: true });
  return { root, store, home };
}

describe("LocalAgentHomeStore path containment", () => {
  it("keeps revision metadata external without reserving a workspace file name", async () => {
    const { root, store } = await fixture();
    const source = path.join(root, "checkpoint-source");
    await mkdir(source);
    await writeFile(path.join(source, "result.txt"), "durable");
    await writeFile(path.join(source, ".revision"), "belongs to the user");

    const revision = await store.commit("bot-1", source, context);
    const exported = [];
    for await (const file of store.exportHome("bot-1", context)) exported.push(file.path);

    expect(revision).toMatch(/^rev-/);
    expect(store.describe().capabilities.revisions).toBe(false);
    expect(exported.sort()).toEqual([".revision", "result.txt"]);
  });

  it("rejects lexical traversal and sibling-prefix paths", async () => {
    const { store } = await fixture();
    await expect(store.readFile("bot-1", "../../homes-other/secret", context)).rejects.toThrow(
      /escapes|invalid/i,
    );
  });

  it("rejects oversized reads before loading their contents", async () => {
    const { store, home } = await fixture();
    await writeFile(path.join(home, "large.txt"), "12345");

    await expect(store.readFile("bot-1", "large.txt", context, { maxBytes: 4 })).rejects.toThrow(
      /exceeds 4 bytes/,
    );
  });

  it("allows symlinks whose resolved target stays inside the bot home", async () => {
    const { store, home } = await fixture();
    await writeFile(path.join(home, "target.txt"), "before");
    await symlink("target.txt", path.join(home, "link.txt"));

    expect(await store.readFile("bot-1", "link.txt", context)).toBe("before");
    await store.writeFile("bot-1", "link.txt", "after", context);
    expect(await readFile(path.join(home, "target.txt"), "utf8")).toBe("after");
  });

  it("allows directory symlinks that remain inside the bot home", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, "target-dir"));
    await symlink("target-dir", path.join(home, "linked-dir"));

    await store.writeFile("bot-1", "linked-dir/result.txt", "safe", context);
    expect(await readFile(path.join(home, "target-dir", "result.txt"), "utf8")).toBe("safe");
    expect(await store.list("bot-1", "linked-dir", context)).toEqual([
      { path: "linked-dir/result.txt", kind: "file", size: 4 },
    ]);
  });

  it("rejects reads and writes through symlinks outside the bot home", async () => {
    const { root, store, home } = await fixture();
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(home, "escape.txt"));

    await expect(store.readFile("bot-1", "escape.txt", context)).rejects.toThrow(/escapes/i);
    await expect(store.writeFile("bot-1", "escape.txt", "changed", context)).rejects.toThrow(
      /escapes/i,
    );
    expect(await readFile(outside, "utf8")).toBe("secret");
  });

  it("does not create directories through an external symlink", async () => {
    const { root, store, home } = await fixture();
    const outside = path.join(root, "outside-dir");
    await mkdir(outside);
    await symlink(outside, path.join(home, "escape-dir"));

    await expect(
      store.writeFile("bot-1", "escape-dir/new/result.txt", "changed", context),
    ).rejects.toThrow(/escapes/i);
    await expect(readFile(path.join(outside, "new", "result.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("hides external symlinks from listings and exports", async () => {
    const { root, store, home } = await fixture();
    await writeFile(path.join(home, "safe.txt"), "safe");
    await symlink(path.join(root, "outside"), path.join(home, "external"));
    await writeFile(path.join(root, "outside"), "secret");

    expect(await store.list("bot-1", "", context)).toEqual([
      { path: "safe.txt", kind: "file", size: 4 },
    ]);
    const exported = [];
    for await (const file of store.exportHome("bot-1", context)) exported.push(file.path);
    expect(exported).toEqual(["safe.txt"]);
  });
});
