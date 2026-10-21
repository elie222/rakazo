import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  asset: {
    uri: "file:///fake/photo.jpg",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    width: 4000 as number | undefined,
    height: 3000 as number | undefined,
  },
  manipulate: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  save: vi.fn(),
  base64: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    info() {
      return { size: 2 * 1024 * 1024 };
    }
    base64() {
      return state.base64();
    }
  },
}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(async () => ({ canceled: false, assets: [state.asset] })),
}));
vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: state.manipulate },
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
}));

import { pickFromLibrary } from "./pick-attachments";

function asset(overrides: Partial<typeof state.asset> = {}) {
  state.asset = {
    uri: "file:///fake/photo.jpg",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    width: 4000,
    height: 3000,
    ...overrides,
  };
}

beforeEach(() => {
  asset();
  state.manipulate.mockReset();
  state.resize.mockReset();
  state.render.mockReset();
  state.save.mockReset();
  state.base64.mockReset();
  state.manipulate.mockImplementation(() => ({ resize: state.resize, renderAsync: state.render }));
  state.render.mockResolvedValue({ saveAsync: state.save });
  state.save.mockResolvedValue({ uri: "file:///fake/photo-resized.jpg" });
  state.base64.mockResolvedValue("aGVsbG8=");
});

describe("image attachment preparation", () => {
  it("leaves a small image untouched", async () => {
    asset({ width: 1000, height: 800 });

    const result = await pickFromLibrary();

    expect(state.manipulate).not.toHaveBeenCalled();
    expect(result.attachments[0]).toMatchObject({
      name: "photo.jpg",
      previewUri: "file:///fake/photo.jpg",
    });
  });

  it("resizes a wide image by width", async () => {
    const result = await pickFromLibrary();

    expect(state.resize).toHaveBeenCalledWith({ width: 1_600 });
    expect(state.save).toHaveBeenCalledWith({ compress: 0.7, format: "jpeg" });
    expect(result.attachments[0]?.previewUri).toBe("file:///fake/photo-resized.jpg");
  });

  it("resizes a tall image by height", async () => {
    asset({ width: 3000, height: 4000 });

    await pickFromLibrary();

    expect(state.resize).toHaveBeenCalledWith({ height: 1_600 });
  });

  it("keeps the original when dimensions are missing", async () => {
    asset({ width: undefined, height: 3000 });

    const result = await pickFromLibrary();

    expect(state.manipulate).not.toHaveBeenCalled();
    expect(result.attachments[0]?.previewUri).toBe("file:///fake/photo.jpg");
  });

  it("does not flatten a GIF", async () => {
    asset({ uri: "file:///fake/photo.gif", fileName: "photo.gif", mimeType: "image/gif" });

    const result = await pickFromLibrary();

    expect(state.manipulate).not.toHaveBeenCalled();
    expect(result.attachments[0]).toMatchObject({
      name: "photo.gif",
      mimeType: "image/gif",
    });
  });

  it("keeps the original when manipulation fails", async () => {
    state.manipulate.mockImplementation(() => {
      throw new Error("unsupported image");
    });

    const result = await pickFromLibrary();

    expect(result.attachments[0]).toMatchObject({
      name: "photo.jpg",
      mimeType: "image/jpeg",
      previewUri: "file:///fake/photo.jpg",
    });
  });
});
