import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fileHandlePath } from "./file-handle-path.js";

it("resolves the held file after its original parent pathname is replaced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-fd-path-"));
  try {
    const parent = path.join(root, "parent");
    const outside = path.join(root, "outside");
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(path.join(parent, "file"), "original");
    await writeFile(path.join(outside, "file"), "replacement");
    const handle = await open(path.join(parent, "file"), "r");
    try {
      const expected = path.join(await realpath(root), "moved/file");
      await rename(parent, path.join(root, "moved"));
      await symlink(outside, parent, "junction");
      expect(await fileHandlePath(handle.fd)).toBe(expected);
      expect(await handle.readFile("utf8")).toBe("original");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
