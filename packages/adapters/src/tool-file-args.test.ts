import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";
import { redactToolArgsForReview } from "./auto-review.js";
import { FakeToolFileStore } from "./fake-tool-files.js";
import {
  LOCAL_FILE_PATH_UNSUPPORTED,
  materializeToolFilePaths,
  readableToolFileArgs,
  restoreToolFilePlaceholders,
  substituteToolFilePlaceholders,
} from "./tool-file-args.js";

const SCOPE = { spaceId: "space-1", userId: "user-1", botId: "bot-1" };
const PDF = new TextEncoder().encode("%PDF-1.7 invoice body");
const PDF_BASE64 = Buffer.from(PDF).toString("base64");

async function storeWithInvoice() {
  const store = new FakeToolFileStore();
  const file = await store.create({
    ...SCOPE,
    name: "invoice.pdf",
    mimeType: "application/pdf",
    bytes: PDF,
  });
  return { store, file };
}

describe("tool file placeholder substitution", () => {
  it("fills base64 and URLs in nested arguments and inside JSON strings, leaving args as is", async () => {
    const { store, file } = await storeWithInvoice();
    const args = {
      // Green Invoice's expense upload_file takes `data` as a JSON string.
      data: JSON.stringify({ filename: "invoice.pdf", file: `{{file:${file.id}}}` }),
      nested: { list: [`see {{file_url:${file.id}}}`, 3, null] },
    };
    const original = structuredClone(args);
    const prepared = await substituteToolFilePlaceholders(args, store, SCOPE);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(JSON.parse(prepared.args.data as string)).toEqual({
      filename: "invoice.pdf",
      file: PDF_BASE64,
    });
    expect(prepared.args.nested).toEqual({ list: [`see ${store.urls[0]}`, 3, null] });
    expect(args).toEqual(original);
    expect(prepared.substitutions.map((entry) => entry.form).sort()).toEqual(["base64", "url"]);
  });

  it("returns arguments without placeholders untouched, even without a store", async () => {
    const args = { city: "Lisbon" };
    expect(await substituteToolFilePlaceholders(args, undefined, SCOPE)).toEqual({
      ok: true,
      args,
      substitutions: [],
    });
  });

  it.each([
    ["an unknown id", "missing", SCOPE],
    ["another bot's file", undefined, { ...SCOPE, botId: "bot-2" }],
    ["another user's file", undefined, { ...SCOPE, userId: "user-2" }],
  ])("fails the call for %s", async (_label, id, scope) => {
    const { store, file } = await storeWithInvoice();
    const placeholder = `{{file:${id ?? file.id}}}`;
    expect(await substituteToolFilePlaceholders({ data: placeholder }, store, scope)).toEqual({
      ok: false,
      error: `File ${placeholder} is not available (it may have expired)`,
    });
  });

  it("fails the call for an expired file and when no store is wired", async () => {
    const { store, file } = await storeWithInvoice();
    store.expire(file.id);
    const args = { url: `{{file_url:${file.id}}}` };
    expect(await substituteToolFilePlaceholders(args, store, SCOPE)).toMatchObject({
      ok: false,
      error: `File {{file_url:${file.id}}} is not available (it may have expired)`,
    });
    expect(await substituteToolFilePlaceholders(args, undefined, SCOPE)).toMatchObject({
      ok: false,
    });
    expect(store.urls).toEqual([]);
  });

  it("refuses a file path unless the connector runs the tool locally", async () => {
    const { store, file } = await storeWithInvoice();
    const args = { attachments: [`{{file_path:${file.id}}}`] };
    expect(await substituteToolFilePlaceholders(args, store, SCOPE)).toEqual({
      ok: false,
      error: LOCAL_FILE_PATH_UNSUPPORTED,
    });
    expect(await substituteToolFilePlaceholders(args, store, SCOPE, { allowPaths: true })).toEqual({
      ok: true,
      args,
      substitutions: [],
    });
  });

  it("puts placeholders back wherever the tool echoed the content or URL", async () => {
    const { store, file } = await storeWithInvoice();
    const prepared = await substituteToolFilePlaceholders(
      { a: `{{file:${file.id}}}`, b: `{{file_url:${file.id}}}` },
      store,
      SCOPE,
    );
    if (!prepared.ok) throw new Error(prepared.error);
    const echoed = {
      content: [{ type: "text", text: `got ${PDF_BASE64} from ${store.urls[0]}` }],
      structuredContent: { raw: JSON.stringify({ file: PDF_BASE64 }) },
    };
    const restored = restoreToolFilePlaceholders(echoed, prepared.substitutions);
    const text = JSON.stringify(restored);
    expect(text).not.toContain(PDF_BASE64);
    expect(text).not.toContain(store.urls[0]);
    expect(restored.content[0]?.text).toBe(`got {{file:${file.id}}} from {{file_url:${file.id}}}`);
  });
});

describe("file path placeholders", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rakazo-tool-file-in-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a private copy with the original name and removes it on cleanup", async () => {
    const { store, file } = await storeWithInvoice();
    const prepared = await materializeToolFilePaths(
      { attachments: [`{{file_path:${file.id}}}`], other: `{{file:${file.id}}}` },
      store,
      SCOPE,
      dir,
    );
    if (!prepared.ok) throw new Error(prepared.error);
    const path = (prepared.args.attachments as string[])[0]!;
    expect(path.startsWith(`${dir}/`)).toBe(true);
    expect(path.endsWith("/invoice.pdf")).toBe(true);
    expect(await readFile(path)).toEqual(Buffer.from(PDF));
    // Other forms are not this step's job.
    expect(prepared.args.other).toBe(`{{file:${file.id}}}`);
    await prepared.cleanup();
    expect(await readdir(dir)).toEqual([]);
  });

  it("fails for a file out of scope and leaves no copy behind", async () => {
    const { store, file } = await storeWithInvoice();
    const other = await store.create({
      ...SCOPE,
      botId: "bot-2",
      name: "secret.pdf",
      mimeType: "application/pdf",
      bytes: PDF,
    });
    const prepared = await materializeToolFilePaths(
      { attachments: [`{{file_path:${file.id}}}`, `{{file_path:${other.id}}}`] },
      store,
      SCOPE,
      dir,
    );
    expect(prepared).toEqual({
      ok: false,
      error: `File {{file_path:${other.id}}} is not available (it may have expired)`,
    });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("readable tool file arguments", () => {
  it("shows a file by name and size on the approval card, never its content", async () => {
    const { store, file } = await storeWithInvoice();
    const args = {
      data: JSON.stringify({ filename: "invoice.pdf", file: `{{file:${file.id}}}` }),
      missing: "{{file_url:gone}}",
    };
    const shown = await readableToolFileArgs(args, store, SCOPE);
    expect(shown.data).toContain("📎 invoice.pdf (21 B)");
    expect(shown.missing).toBe("{{file_url:gone}}");
    const card = buildApprovalAskBlock("effect-1", "mcp__invoices__upload_file", shown, []);
    expect(card.kind === "ask" && card.detail).toContain("📎 invoice.pdf (21 B)");
    expect(JSON.stringify(card)).not.toContain(PDF_BASE64);
    expect(JSON.stringify(redactToolArgsForReview(shown, []))).toContain("📎 invoice.pdf");
  });

  it("keeps placeholders when there is no store or the file is not in scope", async () => {
    const { store, file } = await storeWithInvoice();
    const args = { file: `{{file:${file.id}}}` };
    expect(await readableToolFileArgs(args, undefined, SCOPE)).toBe(args);
    expect(await readableToolFileArgs(args, store, { ...SCOPE, botId: "bot-2" })).toBe(args);
  });
});
