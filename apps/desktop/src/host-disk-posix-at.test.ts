import { constants } from "node:fs";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathFromOpenFd, posixAtAvailable, readdirNamesAt } from "./host-disk-posix-at.js";

const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-desktop-posix-at-"));
  dirs.push(dir);
  return dir;
}

describe("desktop host-disk posix-at", () => {
  it("pathFromOpenFd returns the open inode path without trimming", async () => {
    expect(posixAtAvailable()).toBe(true);
    const dataDir = await tempDir();
    // Trailing space in the final path component is unusual but legal; F_GETPATH
    // must not strip it (grant checks compare against the real path).
    const dir = path.join(dataDir, "granted ");
    await mkdir(dir, { recursive: true });
    const handle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      const fromFd = pathFromOpenFd(handle.fd);
      expect(fromFd.endsWith("granted ")).toBe(true);
      expect(fromFd).not.toMatch(/\/dev\/fd\//);
      expect(fromFd).not.toMatch(/\/proc\/self\/fd\//);
    } finally {
      await handle.close();
    }
  });

  it("readdirNamesAt handles short and long variable-length dirent names", async () => {
    expect(posixAtAvailable()).toBe(true);
    const dataDir = await tempDir();
    const dir = path.join(dataDir, "entries");
    await mkdir(dir, { recursive: true });
    const shortName = "a";
    const longName = `${"n".repeat(200)}.txt`;
    // NAME_MAX (255) — Linux d_reclen pads to 280; must not reject as out of range.
    const maxName = `${"m".repeat(251)}.txt`;
    expect(maxName.length).toBe(255);
    await writeFile(path.join(dir, shortName), "s\n", "utf8");
    await writeFile(path.join(dir, longName), "l\n", "utf8");
    await writeFile(path.join(dir, maxName), "m\n", "utf8");

    const handle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      const names = readdirNamesAt(handle.fd);
      expect(names).toEqual(expect.arrayContaining([shortName, longName, maxName]));
    } finally {
      await handle.close();
    }
  });
});
