import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertComputerHomeWritable, ensureComputerHomeOwnership } from "./home-ownership.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("computer home ownership", () => {
  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "walks existing contents without following symlinks outside the home",
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-owner-"));
      roots.push(parent);
      const home = path.join(parent, "home");
      const outside = path.join(parent, "outside");
      await mkdir(path.join(home, "nested"), { recursive: true });
      await writeFile(path.join(home, "nested", "file.txt"), "inside");
      await writeFile(outside, "outside");
      await symlink(outside, path.join(home, "link"));

      const uid = process.getuid?.() ?? 0;
      const gid = process.getgid?.() ?? 0;
      const outsideBefore = await lstat(outside);
      await ensureComputerHomeOwnership(home, uid, gid);

      await expect(lstat(path.join(home, "nested", "file.txt"))).resolves.toMatchObject({
        uid,
        gid,
      });
      await expect(lstat(home)).resolves.toMatchObject({ uid, gid });
      await expect(lstat(outside)).resolves.toMatchObject({
        uid: outsideBefore.uid,
        gid: outsideBefore.gid,
      });
    },
  );

  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "rejects a symlink as the home root",
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-owner-root-"));
      roots.push(parent);
      const outside = path.join(parent, "outside");
      const home = path.join(parent, "home");
      await mkdir(outside);
      await symlink(outside, home);

      await expect(ensureComputerHomeOwnership(home)).rejects.toMatchObject({
        code: expect.stringMatching(/ELOOP|ENOTDIR/),
      });
    },
  );

  it("no-ops when the supervisor is not root", async () => {
    if (process.getuid?.() === 0) return;

    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-owner-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    await mkdir(home, { recursive: true });
    const file = path.join(home, "file.txt");
    await writeFile(file, "inside");
    const before = await lstat(file);

    await ensureComputerHomeOwnership(home, 1000, 1000);

    await expect(lstat(file)).resolves.toMatchObject({
      uid: before.uid,
      gid: before.gid,
    });
  });

  it("rejects an existing entry that the host-run computer cannot write", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-writable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await chmod(home, 0o777);
    await writeFile(file, "{}");
    await chmod(file, 0o400);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid + 1, stat.gid + 1)).rejects.toThrow(
      /chown -R/,
    );
  });

  it("does not follow symlinks while checking host-run compatibility", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-writable-link-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const outside = path.join(parent, "outside");
    await mkdir(home);
    await writeFile(outside, "outside");
    await chmod(outside, 0o400);
    await symlink(outside, path.join(home, "link"));

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });
});
