import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureComputerHomeOwnership } from "./home-ownership.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("computer home ownership", () => {
  it("walks existing contents without following symlinks outside the home", async () => {
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

    await expect(lstat(path.join(home, "nested", "file.txt"))).resolves.toMatchObject({ uid, gid });
    await expect(lstat(home)).resolves.toMatchObject({ uid, gid });
    await expect(lstat(outside)).resolves.toMatchObject({
      uid: outsideBefore.uid,
      gid: outsideBefore.gid,
    });
  });
});
