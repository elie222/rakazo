import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readDroppedFiles as ReadDroppedFiles } from "./pick-attachments";

const state = vi.hoisted(() => ({
  file: vi.fn(),
  info: vi.fn(),
  base64: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(uri: string) {
      state.file(uri);
    }
    info() {
      return state.info();
    }
    base64() {
      return state.base64();
    }
  },
}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));

let readDroppedFiles: typeof ReadDroppedFiles;

beforeEach(async () => {
  vi.resetModules();
  state.info.mockReset().mockReturnValue({ size: 1024 });
  state.base64.mockReset().mockResolvedValue("aGVsbG8=");
  ({ readDroppedFiles } = await import("./pick-attachments"));
});

const dropped = (name: string, size: number) => ({
  uri: `file:///cache/dropped/${name}`,
  name,
  mimeType: "application/octet-stream",
  size,
});

describe("dropped file attachments", () => {
  it("attaches a supported file that fits", async () => {
    const result = await readDroppedFiles([dropped("note.png", 1024)]);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ name: "note.png", mimeType: "image/png" });
    expect(result.skipped).toEqual([]);
    expect(state.base64).toHaveBeenCalledOnce();
  });

  it("rejects an oversized file without reading it", async () => {
    const result = await readDroppedFiles([dropped("film.mp4", 20 * 1024 * 1024)]);

    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([{ name: "film.mp4", reason: "over 10 MiB" }]);
    expect(state.base64).not.toHaveBeenCalled();
  });

  it("rejects an unsupported file without reading it", async () => {
    const result = await readDroppedFiles([dropped("notes.xyz", 1024)]);

    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([{ name: "notes.xyz", reason: "unsupported type" }]);
    expect(state.base64).not.toHaveBeenCalled();
  });

  it("stops reading once the draft is full", async () => {
    const result = await readDroppedFiles([dropped("late.png", 1024)], ATTACHMENT_MAX_COUNT);

    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "late.png", reason: `max ${ATTACHMENT_MAX_COUNT} attachments` },
    ]);
    expect(state.base64).not.toHaveBeenCalled();
  });

  it("reports files the drop guard refused to copy", async () => {
    const result = await readDroppedFiles([], 0, undefined, ["huge.mov"]);

    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([{ name: "huge.mov", reason: "over 10 MiB" }]);
  });
});
