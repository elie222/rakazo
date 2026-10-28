import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkHomeArchive, HomeArchiveError, packHome, unpackHome } from "./home-archive.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-home-archive-"));
  dirs.push(dir);
  return dir;
}

async function collect(source: AsyncIterable<Uint8Array>) {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

async function* once(bytes: Buffer) {
  yield bytes;
}

/** Every file under a directory with its contents, for comparing trees. */
async function tree(root: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      Object.assign(result, { [`${relative}/`]: "" }, await tree(root, relative));
    else result[relative] = await readFile(path.join(root, relative), "utf8");
  }
  return result;
}

/** Hand-built archive entries, to feed unpack what pack would never write. */
function entry(kind: number, name: string, content?: string, mode = 0o600) {
  const bytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(3);
  header.writeUInt8(kind, 0);
  header.writeUInt16BE(bytes.length, 1);
  if (content === undefined) return Buffer.concat([header, bytes]);
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(mode, 0);
  meta.writeBigUInt64BE(BigInt(Buffer.byteLength(content)), 2);
  return Buffer.concat([header, bytes, meta, Buffer.from(content)]);
}

function archive(...entries: Buffer[]) {
  return Buffer.concat([Buffer.from("RKZH\x01", "latin1"), ...entries, Buffer.from([0])]);
}

describe("home archive", () => {
  it("round-trips files, empty directories, hidden files and permissions", async () => {
    const source = await tempDir();
    await mkdir(path.join(source, ".browser-profiles/default"), { recursive: true });
    await mkdir(path.join(source, "empty"));
    await writeFile(path.join(source, ".browser-profiles/default/Cookies"), "session");
    await writeFile(path.join(source, "notes.txt"), "hello");
    await writeFile(path.join(source, "run.sh"), "#!/bin/sh\n");
    await chmod(path.join(source, "run.sh"), 0o755);
    const dest = path.join(await tempDir(), "home");
    await mkdir(dest);

    await unpackHome(packHome(source), dest);

    expect(await tree(dest)).toEqual(await tree(source));
    expect((await stat(path.join(dest, "run.sh"))).mode & 0o777).toBe(0o755);
  });

  it("copies links that stay in the home and leaves out the rest", async () => {
    const outside = await tempDir();
    await writeFile(path.join(outside, "secret.txt"), "host secret");
    const source = await tempDir();
    await writeFile(path.join(source, "real.txt"), "inside");
    await symlink(path.join(source, "real.txt"), path.join(source, "inside-link"));
    await symlink(path.join(outside, "secret.txt"), path.join(source, "escape-link"));
    await symlink(outside, path.join(source, "escape-dir"));
    await symlink("..", path.join(source, "parent"));
    if (process.platform !== "win32") execFileSync("mkfifo", [path.join(source, "pipe")]);
    const dest = path.join(await tempDir(), "home");
    await mkdir(dest);

    const bytes = await collect(packHome(source));
    await unpackHome(once(bytes), dest);

    expect(await tree(dest)).toEqual({ "real.txt": "inside", "inside-link": "inside" });
    expect(bytes.includes(Buffer.from("host secret"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails instead of leaving out a file it cannot read",
    async () => {
      const source = await tempDir();
      await writeFile(path.join(source, "unreadable"), "x");
      await chmod(path.join(source, "unreadable"), 0o000);
      await expect(collect(packHome(source))).rejects.toThrow(/EACCES/);
    },
  );

  it("refuses to pack a home over the size or entry limit", async () => {
    const source = await tempDir();
    await writeFile(path.join(source, "a"), "12345");
    await writeFile(path.join(source, "b"), "1");
    await expect(collect(packHome(source, { maxBytes: 5, maxEntries: 10 }))).rejects.toThrow(
      HomeArchiveError,
    );
    await expect(collect(packHome(source, { maxBytes: 100, maxEntries: 1 }))).rejects.toThrow(
      HomeArchiveError,
    );
  });

  it.each([
    ["a parent segment", archive(entry(2, "../escape.txt", "x"))],
    ["a nested parent segment", archive(entry(1, "a"), entry(2, "a/../../escape.txt", "x"))],
    ["an absolute path", archive(entry(2, "/etc/escape", "x"))],
    ["an empty segment", archive(entry(2, "a//b", "x"))],
    ["a dot segment", archive(entry(2, "./a", "x"))],
    ["an empty path", archive(entry(2, "", "x"))],
    ["a NUL byte", archive(entry(2, "a\0b", "x"))],
    ["a link or device entry", archive(entry(3, "link", "/etc/passwd"))],
    ["a repeated entry", archive(entry(2, "a", "x"), entry(2, "a", "y"))],
    ["a file under a file", archive(entry(2, "a", "x"), entry(2, "a/b", "y"))],
    ["trailing data", Buffer.concat([archive(entry(2, "a", "x")), Buffer.from("more")])],
    ["a truncated body", archive(entry(2, "a", "x")).subarray(0, 12)],
    ["a missing end marker", archive(entry(2, "a", "x")).subarray(0, -1)],
    ["another format", Buffer.from("PK\x03\x04 not a home")],
  ])("rejects %s when restoring", async (_name, bytes) => {
    const dest = path.join(await tempDir(), "home");
    await mkdir(dest);
    await expect(unpackHome(once(bytes), dest)).rejects.toThrow();
    expect(await readdir(path.dirname(dest))).toEqual(["home"]);
  });

  it("enforces size and entry limits when restoring", async () => {
    const dest = path.join(await tempDir(), "home");
    await mkdir(dest);
    await expect(
      unpackHome(once(archive(entry(2, "big", "123456"))), dest, { maxBytes: 5, maxEntries: 10 }),
    ).rejects.toThrow(/larger than 5 bytes/);
    await expect(
      checkHomeArchive(once(archive(entry(1, "a"), entry(1, "b"))), {
        maxBytes: 10,
        maxEntries: 1,
      }),
    ).rejects.toThrow(/more than 1 entries/);
  });

  it("restores permission bits only, keeping files readable by their owner", async () => {
    const dest = path.join(await tempDir(), "home");
    await mkdir(dest);
    await unpackHome(once(archive(entry(2, "locked", "x", 0o4000 | 0o000))), dest);
    expect((await stat(path.join(dest, "locked"))).mode & 0o7777).toBe(0o600);
  });
});
