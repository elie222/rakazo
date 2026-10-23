import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ read: vi.fn(), base64: vi.fn() }));
vi.mock("./incoming-share", () => ({ readIncomingShareFile: state.read }));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-image-picker", () => ({}));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => null,
  Platform: { OS: "android" },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    info() {
      return { size: 3 };
    }
    base64 = state.base64;
  },
}));
const { readSharedFiles } = await import("./pick-attachments");
const files = Array.from({ length: 7 }, (_, i) => ({
  uri: `content://photo/${i}`,
  name: `${i}.png`,
  mimeType: "image/png",
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.base64.mockResolvedValue("YWJj");
  state.read.mockImplementation((uri, _maxBytes, read) =>
    read({ uri: "file:///cache/copy" }, `${uri.split("/").at(-1)}.png`, "image/png"),
  );
});
describe("shared files", () => {
  it("keeps readable files and reports individual failures", async () => {
    state.read.mockRejectedValueOnce(new Error("unreadable"));
    const result = await readSharedFiles(files.slice(0, 3));
    expect(result.attachments).toHaveLength(2);
    expect(result.failedFiles).toEqual([files[0]]);
    expect(result.skipped).toEqual([{ name: "0.png", reason: "could not read" }]);
    expect(result.attachments[0]?.previewUri).toBe("data:image/png;base64,YWJj");
  });
  it("does not copy or read beyond the remaining attachment limit", async () => {
    const result = await readSharedFiles(files, 2);
    expect(result.attachments).toHaveLength(2);
    expect(result.skipped).toHaveLength(5);
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(state.base64).toHaveBeenCalledTimes(2);
  });
  it("reports oversized sources without retrying", async () => {
    state.read.mockResolvedValueOnce(null);
    const result = await readSharedFiles(files.slice(0, 1), 0, 1024 * 1024);
    expect(result.attachments).toEqual([]);
    expect(result.failedFiles).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("over 1 MiB");
  });
  it("reads nothing when the composer is full", async () => {
    expect((await readSharedFiles(files, 4)).skipped).toHaveLength(7);
    expect(state.read).not.toHaveBeenCalled();
  });
});
