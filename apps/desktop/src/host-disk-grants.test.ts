import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDiskGrantStore } from "./host-disk-grants.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-host-grants-"));
  dirs.push(dir);
  return dir;
}

describe("host disk grant store", () => {
  it("does not resurrect a root revoked while the grants file is still loading", async () => {
    const dir = await tempDir();
    const grantsFilePath = path.join(dir, "host-disk-grants.json");
    const granted = path.join(dir, "Documents");
    await mkdir(granted);
    await writeFile(grantsFilePath, `${JSON.stringify([granted], null, 2)}\n`, "utf8");

    // Start load without awaiting; revoke records intent first then waits on ready.
    const store = createHostDiskGrantStore({ grantsFilePath });
    await expect(store.revoke(granted)).resolves.toBe(true);
    await store.ready;
    expect(store.list()).not.toContain(path.resolve(granted));

    const persisted = JSON.parse(await readFile(grantsFilePath, "utf8")) as unknown[];
    expect(persisted).toEqual([]);
  });

  it("always persists revoke even when the root was not yet in memory", async () => {
    const dir = await tempDir();
    const grantsFilePath = path.join(dir, "host-disk-grants.json");
    const granted = path.join(dir, "Projects");
    await mkdir(granted);
    await writeFile(grantsFilePath, `${JSON.stringify([granted], null, 2)}\n`, "utf8");

    const store = createHostDiskGrantStore({ grantsFilePath });
    await store.revoke(granted);
    expect(store.list()).toEqual([]);
    const persisted = JSON.parse(await readFile(grantsFilePath, "utf8")) as unknown[];
    expect(persisted).toEqual([]);
  });

  it("returns false when revoking a path that was never granted", async () => {
    const dir = await tempDir();
    const grantsFilePath = path.join(dir, "host-disk-grants.json");
    await writeFile(grantsFilePath, `${JSON.stringify([], null, 2)}\n`, "utf8");

    const store = createHostDiskGrantStore({ grantsFilePath });
    await store.ready;
    await expect(store.revoke(path.join(dir, "never-granted"))).resolves.toBe(false);
  });

  it("serializes concurrent add/revoke so disk matches the final in-memory set", async () => {
    const dir = await tempDir();
    const grantsFilePath = path.join(dir, "host-disk-grants.json");
    const granted = path.join(dir, "Workspace");
    await mkdir(granted);

    const store = createHostDiskGrantStore({ grantsFilePath });
    await store.ready;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await store.add(granted);
      await Promise.all([store.add(granted), store.revoke(granted)]);
      const persisted = JSON.parse(await readFile(grantsFilePath, "utf8")) as Array<{
        path: string;
      }>;
      const listed = store.list();
      expect(persisted.map((entry) => path.resolve(entry.path)).sort()).toEqual([...listed].sort());
    }
  });

  it("does not authorize a grant pathname replaced by a symlink to an ungranted folder", async () => {
    const dir = await tempDir();
    const grantsFilePath = path.join(dir, "host-disk-grants.json");
    const granted = path.join(dir, "Granted");
    const outside = path.join(dir, "Outside");
    await mkdir(granted);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "nope\n", "utf8");

    const store = createHostDiskGrantStore({ grantsFilePath });
    await store.ready;
    const added = await store.add(granted);
    const { realpath } = await import("node:fs/promises");
    const authorized = await store.authorizedRealRoots();
    expect(authorized).toEqual([expect.objectContaining({ path: await realpath(granted) })]);
    expect(authorized[0]?.dev).toMatch(/^\d+$/);
    expect(authorized[0]?.ino).toMatch(/^\d+$/);
    expect(store.list()).toEqual([added]);

    const backup = path.join(dir, "Granted-original");
    await rename(granted, backup);
    await symlink(outside, granted);

    // Pathname remains listed, but authorization must not follow the symlink.
    expect(store.list()).toEqual([added]);
    expect(await store.authorizedRealRoots()).toEqual([]);
  });

  it("does not let a mid-check root pathname swap poison authorizedRealRoots", async () => {
    // After the grant fd identity is verified, replacing the pathname with a
    // symlink to an outside directory must not make that outside path an
    // authorized root. The allowlist path comes from the open fd.
    const dir = await tempDir();
    const grantsFilePath = path.join(dir, "host-disk-grants.json");
    const granted = path.join(dir, "Granted");
    const outside = path.join(dir, "Outside");
    await mkdir(granted);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "nope\n", "utf8");

    const backup = path.join(dir, "Granted-original");
    const store = createHostDiskGrantStore({
      grantsFilePath,
      afterAuthorizedIdentityVerified: async () => {
        await rename(granted, backup);
        await symlink(outside, granted);
      },
    });
    await store.ready;
    await store.add(granted);

    const { realpath } = await import("node:fs/promises");
    const roots = await store.authorizedRealRoots();
    expect(roots).toEqual([expect.objectContaining({ path: await realpath(backup) })]);
    expect(roots.map((root) => root.path)).not.toContain(await realpath(outside));
  });

  it("returns grant identity so IPC can reject a post-return directory swap", async () => {
    const dir = await tempDir();
    const grantsFilePath = path.join(dir, "host-disk-grants.json");
    const granted = path.join(dir, "Granted");
    await mkdir(granted);
    await writeFile(path.join(granted, "ok.txt"), "yes\n", "utf8");

    const store = createHostDiskGrantStore({ grantsFilePath });
    await store.ready;
    await store.add(granted);

    const roots = await store.authorizedRealRoots();
    expect(roots).toHaveLength(1);
    const root = roots[0]!;

    const backup = path.join(dir, "Granted-original");
    await rename(granted, backup);
    await mkdir(granted);
    await writeFile(path.join(granted, "evil.txt"), "no\n", "utf8");

    const { open } = await import("node:fs/promises");
    const { constants: fsConsts } = await import("node:fs");
    const handle = await open(
      root.path,
      fsConsts.O_RDONLY | (fsConsts.O_DIRECTORY ?? 0) | (fsConsts.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat();
      // Same pathname, different inode — IPC must refuse via returned identity.
      expect(String(info.dev) === root.dev && String(info.ino) === root.ino).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("does not realpath an fd-derived path after a post-derivation symlink swap", async () => {
    // pathFromOpenFd returns a pathname string; replacing that path with an
    // outside symlink before confirmation must fail closed — never authorize outside.
    const dir = await tempDir();
    const grantsFilePath = path.join(dir, "host-disk-grants.json");
    const granted = path.join(dir, "Granted");
    const outside = path.join(dir, "Outside");
    await mkdir(granted);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "nope\n", "utf8");

    const backup = path.join(dir, "Granted-original");
    const store = createHostDiskGrantStore({
      grantsFilePath,
      afterAuthorizedFdPathDerived: async () => {
        await rename(granted, backup);
        await symlink(outside, granted);
      },
    });
    await store.ready;
    await store.add(granted);

    const { realpath } = await import("node:fs/promises");
    const roots = await store.authorizedRealRoots();
    expect(roots.map((root) => root.path)).not.toContain(await realpath(outside));
    // Fail closed on the swapped pathname (O_NOFOLLOW reopen fails / identity miss).
    expect(roots).toEqual([]);
  });

  it("captureGrantIdentity opens before resolving path (no realpath-then-open race)", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./host-disk-grants.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function captureGrantIdentity");
    const end = source.indexOf("export function createHostDiskGrantStore");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const fn = source.slice(start, end);
    expect(fn).not.toMatch(/await\s+realpath\(/);
    expect(fn).toMatch(/pathFromOpenFd\(/);
    expect(fn).toMatch(/O_RDONLY\s*\|\s*DIRECTORY\s*\|\s*NOFOLLOW/);
  });
});
