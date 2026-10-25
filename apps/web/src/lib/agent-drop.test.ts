import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CapturedDrop } from "./agent-drop";
import { droppedAgent, mightBeAgent } from "./agent-drop";

type Tree = { [name: string]: string | Tree };

/** A minimal stored zip, as a backup tool would write one. */
function zip(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const body = new TextEncoder().encode(content);
    const crc = crc32(body);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, body.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const record = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, body.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    record.set(nameBytes, 46);
    parts.push(local, body);
    central.push(record);
    offset += local.length + body.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A dropped folder as the browser's file system entries describe it. */
function folder(name: string, tree: Tree, opened: string[], parent = ""): FileSystemDirectoryEntry {
  const fullPath = `${parent}/${name}`;
  const children = Object.entries(tree).map(([child, value]) =>
    typeof value === "string"
      ? ({
          name: child,
          fullPath: `${fullPath}/${child}`,
          isFile: true,
          isDirectory: false,
          file: (resolve: (file: File) => void) => {
            opened.push(`${fullPath}/${child}`.slice(1));
            resolve(new File([value], child));
          },
        } as unknown as FileSystemEntry)
      : folder(child, value, opened, fullPath),
  );
  let listed = false;
  return {
    name,
    fullPath,
    isFile: false,
    isDirectory: true,
    createReader: () => ({
      readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
        resolve(listed ? [] : children);
        listed = true;
      },
    }),
  } as unknown as FileSystemDirectoryEntry;
}

describe("a drop into the chat", () => {
  it("is looked at only when it is one folder or one backup", () => {
    const entry = folder("x", {}, []);
    expect(mightBeAgent({ entries: [entry], files: [] })).toBe(true);
    expect(mightBeAgent({ entries: [], files: [new File([""], "backup.tar.gz")] })).toBe(true);
    expect(mightBeAgent({ entries: [], files: [new File([""], "notes.md")] })).toBe(false);
    expect(
      mightBeAgent({ entries: [], files: [new File([""], "a.zip"), new File([""], "b.zip")] }),
    ).toBe(false);
  });

  it("recognises an OpenClaw home by its names, opening only the files an import reads", async () => {
    const opened: string[] = [];
    const drop: CapturedDrop = {
      entries: [
        folder(
          "openclaw-home",
          {
            "openclaw.json": "{}",
            ".env": "OPENROUTER_API_KEY=placeholder-key\n",
            workspace: { "SOUL.md": "Calm.\n", "notes.txt": "x" },
            sessions: { "today.md": "private" },
            node_modules: { pkg: { "README.md": "x" } },
          },
          opened,
        ),
      ],
      files: [],
    };
    const agent = await droppedAgent(drop);
    expect(agent?.paths.sort()).toEqual([
      "openclaw-home/.env",
      "openclaw-home/openclaw.json",
      "openclaw-home/sessions/today.md",
      "openclaw-home/workspace/SOUL.md",
      "openclaw-home/workspace/notes.txt",
    ]);
    // Opened (not read) only for files an import may use; never sessions or node_modules.
    expect(opened.sort()).toEqual([
      "openclaw-home/.env",
      "openclaw-home/openclaw.json",
      "openclaw-home/workspace/SOUL.md",
    ]);
    expect(await agent!.read("openclaw-home/workspace/SOUL.md")).toBe("Calm.\n");
    expect(() => agent!.read("openclaw-home/sessions/today.md")).toThrow();
  });

  it("leaves an ordinary folder or archive alone", async () => {
    const opened: string[] = [];
    expect(
      await droppedAgent({
        entries: [folder("repo", { "AGENTS.md": "x", src: { "index.ts": "x" } }, opened)],
        files: [],
      }),
    ).toBeNull();
    expect(opened).toEqual([]);
    const plain = zip({ "photo.txt": "x" });
    expect(
      await droppedAgent({ entries: [], files: [new File([plain], "photos.zip")] }),
    ).toBeNull();
    expect(
      await droppedAgent({ entries: [], files: [new File(["not a zip"], "broken.zip")] }),
    ).toBeNull();
  });

  it("recognises a Hermes backup from its entry list", async () => {
    const backup = zip({
      "SOUL.md": "Direct.\n",
      "config.yaml": "model:\n  provider: openrouter\n",
    });
    const agent = await droppedAgent({ entries: [], files: [new File([backup], "hermes.zip")] });
    expect(agent?.paths).toEqual([".hermes/SOUL.md", ".hermes/config.yaml"]);
  });
});
