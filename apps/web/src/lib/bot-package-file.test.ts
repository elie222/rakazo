import type { BotPackageExport } from "@rakazo/contracts";
import { BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { downloadBotPackage, readBotPackageFile } from "./bot-package-file";

const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("./artifact-open", () => ({ downloadArtifactBytes: download }));

beforeEach(() => vi.clearAllMocks());

function file(bytes: Uint8Array, size = bytes.byteLength) {
  const read = vi.fn(async () => bytes.buffer);
  const slice = vi.fn(() => ({ arrayBuffer: read }));
  return { value: { size, slice } as unknown as File, read, slice };
}

it("reads bounded UTF-8 package text without relying on MIME or an extension", async () => {
  const input = file(new TextEncoder().encode('{"name":"研究"}'));
  expect(await readBotPackageFile(input.value, () => true)).toBe('{"name":"研究"}');
  expect(input.slice).toHaveBeenCalledExactlyOnceWith(0, BOT_PACKAGE_MAX_BYTES + 1);
});

it("refuses a declared oversized file before reading it", async () => {
  const input = file(new Uint8Array(), BOT_PACKAGE_MAX_BYTES + 1);
  await expect(readBotPackageFile(input.value, () => true)).rejects.toThrow("4 MiB");
  expect(input.read).not.toHaveBeenCalled();
});

it("checks actual bytes when a file grows or its declared size is wrong", async () => {
  const input = file(new Uint8Array(BOT_PACKAGE_MAX_BYTES + 1), 1);
  await expect(readBotPackageFile(input.value, () => true)).rejects.toThrow("4 MiB");
});

it("rejects malformed UTF-8 instead of replacing original bytes", async () => {
  const input = file(Uint8Array.of(0xff));
  await expect(readBotPackageFile(input.value, () => true)).rejects.toThrow();
});

it("discards a file read when the editor's captured scope expires", async () => {
  let current = true;
  let finish!: (value: ArrayBuffer) => void;
  const input = file(new Uint8Array());
  input.read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const reading = readBotPackageFile(input.value, () => current);
  current = false;
  finish(new TextEncoder().encode("{}").buffer);
  await expect(reading).rejects.toThrow("no longer current");
});

it("never reads or downloads for an obsolete account scope", async () => {
  const input = file(new Uint8Array());
  await expect(readBotPackageFile(input.value, () => false)).rejects.toThrow("no longer current");
  expect(input.read).not.toHaveBeenCalled();
  expect(() =>
    downloadBotPackage({ json: "{}", filename: "bot.json" } as BotPackageExport, () => false),
  ).toThrow("no longer current");
  expect(download).not.toHaveBeenCalled();
});

it("bounds exported bytes and downloads only a safe JSON filename", () => {
  const result = { json: '{"name":"研究"}', filename: "../../folder\\bot" } as BotPackageExport;
  downloadBotPackage(result, () => true);
  expect(download).toHaveBeenCalledExactlyOnceWith(
    expect.not.stringMatching(/[\\/]/),
    "application/json",
    new TextEncoder().encode(result.json),
  );
  expect(download.mock.calls[0]![0]).toMatch(/\.json$/);
  expect(() =>
    downloadBotPackage(
      { json: "中".repeat(BOT_PACKAGE_MAX_BYTES / 2), filename: "bot.json" } as BotPackageExport,
      () => true,
    ),
  ).toThrow("4 MiB");
  expect(download).toHaveBeenCalledOnce();
});
