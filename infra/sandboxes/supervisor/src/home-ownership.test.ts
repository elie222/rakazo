import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertComputerHomeWritable, assertOpenedDirectoryBeneathRoot } from "./home-ownership.js";

const roots: string[] = [];
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("computer home ownership", () => {
  it("rejects a missing home instead of creating it as root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-missing-"));
    roots.push(parent);

    await expect(
      assertComputerHomeWritable(path.join(parent, "missing"), 1000, 1000),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects a symlink as the home root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-root-link-"));
    roots.push(parent);
    const outside = path.join(parent, "outside");
    const home = path.join(parent, "home");
    await mkdir(outside);
    await symlink(outside, home);

    await expect(assertComputerHomeWritable(home, 1000, 1000)).rejects.toThrow(/symbolic link/);
  });

  it("rejects a writable regular file as the home root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-file-root-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    await writeFile(home, "{}");
    await chmod(home, 0o600);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(
      /must be a directory/,
    );
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

  it("rejects an owner-owned file that is not writable by that owner", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-owner-mode-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o400);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(/chown -R/);
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

  it.skipIf(process.platform !== "linux")(
    "rejects an opened directory that was moved outside the home",
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "rakazo-home-moved-"));
      roots.push(parent);
      const home = path.join(parent, "home");
      const outside = path.join(parent, "outside");
      const child = path.join(home, "nested");
      await mkdir(child, { recursive: true });
      await mkdir(outside, { recursive: true });
      const handle = await open(child, DIRECTORY_OPEN_FLAGS);
      try {
        await rename(child, path.join(outside, "nested"));
        await expect(assertOpenedDirectoryBeneathRoot(handle, home)).rejects.toThrow(
          /escaped validated root/,
        );
      } finally {
        await handle.close();
      }
    },
  );
});
