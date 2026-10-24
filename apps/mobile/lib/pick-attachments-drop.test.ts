import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readDroppedFiles as ReadDroppedFiles } from "./pick-attachments";

const state = vi.hoisted(() => ({
  file: vi.fn(),
  info: vi.fn(),
  base64: vi.fn(),
  deleted: [] as string[],
}));

vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
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
vi.mock("./file-drop", () => ({
  releaseDroppedFile: async (uri: string) => {
    state.deleted.push(uri);
  },
}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));

let readDroppedFiles: typeof ReadDroppedFiles;

beforeEach(async () => {
  vi.resetModules();
  state.info.mockReset().mockReturnValue({ size: 1024 });
  state.base64.mockReset().mockResolvedValue("aGVsbG8=");
  state.deleted.length = 0;
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

  it("deletes the cached copy of a file it will not attach", async () => {
    await readDroppedFiles([dropped("film.mp4", 20 * 1024 * 1024), dropped("note.png", 1024)]);

    expect(state.deleted).toEqual([
      "file:///cache/dropped/film.mp4",
      "file:///cache/dropped/note.png",
    ]);
  });

  it("rejects an unsupported file without reading it", async () => {
    const result = await readDroppedFiles([dropped("notes.xyz", 1024)]);

    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([{ name: "notes.xyz", reason: "unsupported type" }]);
    expect(state.base64).not.toHaveBeenCalled();
  });

  it("reports uncopied oversized files with the normal size reason without reading", async () => {
    const result = await readDroppedFiles(
      [{ name: "huge.mov", mimeType: "video/quicktime", size: 2 * 1024 * 1024 }],
      0,
      1024 * 1024,
    );
    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([{ name: "huge.mov", reason: "over 1 MiB" }]);
    expect(state.base64).not.toHaveBeenCalled();
    expect(state.deleted).toEqual([]);
  });

  it("keeps the rest of a drop when one copy cannot be read", async () => {
    state.base64.mockRejectedValueOnce(new Error("gone"));

    const result = await readDroppedFiles([dropped("gone.png", 1024), dropped("kept.png", 1024)]);

    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["kept.png"]);
    expect(result.skipped).toEqual([{ name: "gone.png", reason: "permission denied" }]);
    expect(state.deleted).toContain("file:///cache/dropped/gone.png");
  });

  it("uses a data preview and reads only remaining slots", async () => {
    const result = await readDroppedFiles(
      [dropped("one.png", 10), dropped("two.png", 10)],
      ATTACHMENT_MAX_COUNT - 1,
    );
    expect(result.attachments[0]?.previewUri).toBe("data:image/png;base64,aGVsbG8=");
    expect(state.base64).toHaveBeenCalledOnce();
    expect(result.skipped[0]?.reason).toBe(`max ${ATTACHMENT_MAX_COUNT} attachments`);
    expect(state.deleted).toHaveLength(2);
  });

  it("checks the copied file's actual size before reading", async () => {
    state.info.mockReturnValue({ size: 20 * 1024 * 1024 });
    const result = await readDroppedFiles([dropped("one.png", 10), dropped("two.png", 10)]);
    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "one.png", reason: "over 10 MiB" },
      { name: "two.png", reason: "over 10 MiB" },
    ]);
    expect(state.base64).not.toHaveBeenCalled();
    expect(state.deleted).toHaveLength(2);
  });

  it("reports native overflow names without reading files", async () => {
    const result = await readDroppedFiles([], 0, undefined, ["extra.png", "another.pdf"]);
    expect(result.attachments).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "extra.png", reason: `max ${ATTACHMENT_MAX_COUNT} attachments` },
      { name: "another.pdf", reason: `max ${ATTACHMENT_MAX_COUNT} attachments` },
    ]);
    expect(state.base64).not.toHaveBeenCalled();
  });
});
