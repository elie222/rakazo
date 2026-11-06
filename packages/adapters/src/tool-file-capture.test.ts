import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeToolFileStore } from "./fake-tool-files.js";
import { captureMcpBinaryContent, importOutputFiles } from "./tool-file-capture.js";

const SCOPE = { spaceId: "space-1", userId: "user-1", botId: "bot-1" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function target(store = new FakeToolFileStore()) {
  return { store, scope: SCOPE, runId: "run-1" };
}

describe("MCP binary content capture", () => {
  it("stores images, audio and binary resources and leaves mentions in their place", async () => {
    const store = new FakeToolFileStore();
    const result = {
      content: [
        { type: "text", text: "Here you go" },
        { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
        { type: "audio", data: PNG.toString("base64"), mimeType: "audio/mpeg" },
        {
          type: "resource",
          resource: {
            uri: "file:///reports/Q3%20report.pdf",
            mimeType: "application/pdf",
            blob: PNG.toString("base64"),
          },
        },
        { type: "resource", resource: { uri: "note://1", mimeType: "text/plain", text: "hi" } },
      ],
      structuredContent: { ok: true },
    };
    const captured = (await captureMcpBinaryContent(result, target(store))) as typeof result;
    expect(captured.structuredContent).toEqual({ ok: true });
    expect(captured.content[0]).toEqual({ type: "text", text: "Here you go" });
    expect(captured.content[4]).toEqual(result.content[4]);
    const files = [...store.files.values()];
    expect(files.map((file) => [file.name, file.mimeType, file.runId, file.botId])).toEqual([
      ["image-1.png", "image/png", "run-1", "bot-1"],
      ["audio-1.mp3", "audio/mpeg", "run-1", "bot-1"],
      ["Q3 report.pdf", "application/pdf", "run-1", "bot-1"],
    ]);
    expect(Buffer.from(files[0]!.bytes)).toEqual(PNG);
    for (const [index, file] of files.entries()) {
      const item = captured.content[index + 1] as { type: string; text: string };
      expect(item.type).toBe("text");
      expect(item.text).toContain(`{{file:${file.id}}}`);
      expect(item.text).toContain(`"${file.name}"`);
    }
    expect(JSON.stringify(captured)).not.toContain(PNG.toString("base64"));
  });

  it("returns a result without binary content as it is", async () => {
    const result = { content: [{ type: "text", text: "plain" }] };
    expect(await captureMcpBinaryContent(result, target())).toBe(result);
  });

  it("says a file was too large instead of passing its bytes on", async () => {
    const store = new FakeToolFileStore({ maxBytes: 4 });
    const captured = (await captureMcpBinaryContent(
      { content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] },
      target(store),
    )) as { content: Array<{ type: string; text: string }> };
    expect(captured.content[0]?.type).toBe("text");
    expect(captured.content[0]?.text).toContain("too large");
    expect(captured.content[0]?.text).not.toContain(PNG.toString("base64"));
    expect(store.files.size).toBe(0);
  });
});

describe("output folder import", () => {
  let base: string;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "rakazo-tool-file-capture-"));
    workspace = join(base, "ws");
    outside = join(base, "outside");
    await mkdir(join(workspace, "out"), { recursive: true });
    await mkdir(join(workspace, "in"), { recursive: true });
    await mkdir(outside);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const textResult = (text: string) => ({ content: [{ type: "text", text }] });

  it("stores a file the result names, deletes it and rewrites the text", async () => {
    const store = new FakeToolFileStore();
    const saved = join(workspace, "out", "invoice 2024.pdf");
    const other = join(workspace, "out", "someone else.pdf");
    await writeFile(saved, "%PDF invoice");
    await writeFile(other, "%PDF other");
    const imported = (await importOutputFiles(
      {
        ...textResult(`Attachment saved to ${saved}.`),
        structuredContent: { path: saved },
      },
      [workspace],
      target(store),
    )) as { content: Array<{ text: string }>; structuredContent: { path: string } };
    const [file] = [...store.files.values()];
    expect(file).toMatchObject({ name: "invoice 2024.pdf", mimeType: "application/pdf" });
    expect(Buffer.from(file!.bytes).toString()).toBe("%PDF invoice");
    expect(imported.content[0]?.text).toMatch(/^Attachment saved to \[file "invoice 2024\.pdf"/);
    expect(imported.content[0]?.text).toContain(`{{file:${file!.id}}}`);
    expect(imported.content[0]?.text.endsWith(".")).toBe(true);
    expect(imported.structuredContent.path).toContain(`{{file:${file!.id}}}`);
    expect(JSON.stringify(imported)).not.toContain(workspace);
    // Deleted from disk; the file the result did not name stays.
    expect(await readdir(join(workspace, "out"))).toEqual(["someone else.pdf"]);
    expect(await readFile(other, "utf8")).toBe("%PDF other");
  });

  it("takes the longest name that exists, not a shorter file it starts with", async () => {
    const store = new FakeToolFileStore();
    await writeFile(join(workspace, "out", "a.pdf"), "short");
    await writeFile(join(workspace, "out", "a.pdf.1"), "long");
    await importOutputFiles(
      textResult(`saved ${join(workspace, "out", "a.pdf.1")}`),
      [workspace],
      target(store),
    );
    expect([...store.files.values()].map((file) => file.name)).toEqual(["a.pdf.1"]);
    expect(await readdir(join(workspace, "out"))).toEqual(["a.pdf"]);
  });

  it("ignores paths outside the workspace, symlinks out of it and `..` escapes", async () => {
    const store = new FakeToolFileStore();
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "private");
    const link = join(workspace, "out", "link.txt");
    await symlink(secret, link);
    const dotdot = join(workspace, "out", "..", "..", "outside", "secret.txt");
    const text = `a ${secret} b ${link} c ${dotdot} d /etc/hostname`;
    const result = textResult(text);
    expect(await importOutputFiles(result, [workspace], target(store))).toBe(result);
    expect(store.files.size).toBe(0);
    expect(await readFile(secret, "utf8")).toBe("private");
    expect(await readdir(join(workspace, "out"))).toEqual(["link.txt"]);
  });

  it("never imports from an excluded folder", async () => {
    const store = new FakeToolFileStore();
    const copy = join(workspace, "in", "attachment.pdf");
    await writeFile(copy, "%PDF");
    const result = textResult(`sent ${copy}`);
    expect(
      await importOutputFiles(result, [workspace], target(store), [join(workspace, "in")]),
    ).toBe(result);
    expect(await readdir(join(workspace, "in"))).toEqual(["attachment.pdf"]);
  });

  it("finds files under a workspace reached through a symlinked parent", async () => {
    const store = new FakeToolFileStore();
    const alias = join(base, "alias");
    await symlink(workspace, alias);
    await writeFile(join(workspace, "out", "photo.jpg"), "jpg");
    await importOutputFiles(
      textResult(`saved ${join(alias, "out", "photo.jpg")}`),
      [alias],
      target(store),
    );
    expect([...store.files.values()].map((file) => [file.name, file.mimeType])).toEqual([
      ["photo.jpg", "image/jpeg"],
    ]);
  });
});
