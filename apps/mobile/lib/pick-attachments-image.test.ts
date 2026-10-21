import Module from "node:module";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { pickFromLibrary as PickFromLibrary } from "./pick-attachments";

const state = vi.hoisted(() => ({
  asset: {
    uri: "file:///fake/photo.jpg",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    width: 4000 as number | undefined,
    height: 3000 as number | undefined,
  },
  assets: [] as Array<{
    uri: string;
    fileName: string;
    mimeType: string;
    width: number | undefined;
    height: number | undefined;
  }>,
  file: vi.fn(),
  info: vi.fn(),
  manipulate: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  save: vi.fn(),
  base64: vi.fn(),
  optionalNativeModule: vi.fn(),
  loadManipulator: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(private uri: string) {
      state.file(uri);
    }
    info() {
      return state.info();
    }
    base64() {
      return state.base64(this.uri);
    }
  },
}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(async () => ({ canceled: false, assets: state.assets })),
}));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: state.optionalNativeModule,
}));

// Vitest's ESM mocks do not intercept Metro's CommonJS require.
const nodeModule = Module as unknown as {
  _load: (id: string, ...args: unknown[]) => unknown;
};
const originalLoad = nodeModule._load;

let pickFromLibrary: typeof PickFromLibrary;

function asset(overrides: Partial<typeof state.asset> = {}) {
  state.asset = {
    uri: "file:///fake/photo.jpg",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    width: 4000,
    height: 3000,
    ...overrides,
  };
  state.assets = [state.asset];
}

beforeEach(async () => {
  vi.resetModules();
  state.optionalNativeModule.mockReset().mockReturnValue({});
  state.loadManipulator.mockReset().mockImplementation(() => ({
    ImageManipulator: { manipulate: state.manipulate },
    SaveFormat: { JPEG: "jpeg", PNG: "png" },
  }));
  vi.spyOn(nodeModule, "_load").mockImplementation((id, ...args) =>
    id === "expo-image-manipulator"
      ? state.loadManipulator(id)
      : originalLoad.call(Module, id, ...args),
  );
  ({ pickFromLibrary } = await import("./pick-attachments"));
  asset();
  state.assets = [state.asset];
  state.file.mockReset();
  state.info.mockReset().mockReturnValue({ size: 2 * 1024 * 1024 });
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

afterEach(() => vi.restoreAllMocks());

describe("image attachment preparation", () => {
  it("keeps the original when the native module is absent", async () => {
    state.optionalNativeModule.mockReturnValue(null);

    const result = await pickFromLibrary();
    await pickFromLibrary();

    expect(state.optionalNativeModule).toHaveBeenCalledExactlyOnceWith("ExpoImageManipulator");
    expect(state.loadManipulator).not.toHaveBeenCalled();
    expect(state.manipulate).not.toHaveBeenCalled();
    expect(state.file).toHaveBeenCalledWith(state.asset.uri);
    expect(state.base64).toHaveBeenCalledWith(state.asset.uri);
    expect(result.attachments[0]).toMatchObject({
      name: "photo.jpg",
      mimeType: "image/jpeg",
      previewUri: "file:///fake/photo.jpg",
      contentBase64: "aGVsbG8=",
    });
  });

  it("keeps the original when loading the manipulator throws", async () => {
    state.loadManipulator.mockImplementation(() => {
      throw new Error("native module unavailable");
    });

    const result = await pickFromLibrary();
    await pickFromLibrary();

    expect(state.loadManipulator).toHaveBeenCalledExactlyOnceWith("expo-image-manipulator");
    expect(state.manipulate).not.toHaveBeenCalled();
    expect(state.file).toHaveBeenCalledWith(state.asset.uri);
    expect(state.base64).toHaveBeenCalledWith(state.asset.uri);
    expect(result.attachments[0]).toMatchObject({
      name: "photo.jpg",
      mimeType: "image/jpeg",
      previewUri: "file:///fake/photo.jpg",
      contentBase64: "aGVsbG8=",
    });
  });

  it("leaves a small image untouched", async () => {
    asset({ width: 1000, height: 800 });

    const result = await pickFromLibrary();

    expect(state.manipulate).not.toHaveBeenCalled();
    expect(state.file).toHaveBeenCalledWith(state.asset.uri);
    expect(state.base64).toHaveBeenCalledWith(state.asset.uri);
    expect(result.attachments[0]).toMatchObject({
      name: "photo.jpg",
      previewUri: "file:///fake/photo.jpg",
    });
  });

  it("resizes a wide image by width", async () => {
    const result = await pickFromLibrary();

    expect(state.file).toHaveBeenCalledExactlyOnceWith("file:///fake/photo-resized.jpg");
    expect(state.base64).toHaveBeenCalledExactlyOnceWith("file:///fake/photo-resized.jpg");
    expect(state.resize).toHaveBeenCalledWith({ width: 1_600 });
    expect(state.save).toHaveBeenCalledWith({ compress: 0.7, format: "jpeg" });
    expect(result.attachments[0]?.previewUri).toBe("file:///fake/photo-resized.jpg");
  });

  it("resizes a tall image by height", async () => {
    asset({ width: 3000, height: 4000 });

    await pickFromLibrary();

    expect(state.file).toHaveBeenCalledExactlyOnceWith("file:///fake/photo-resized.jpg");
    expect(state.base64).toHaveBeenCalledExactlyOnceWith("file:///fake/photo-resized.jpg");
    expect(state.resize).toHaveBeenCalledWith({ height: 1_600 });
  });

  it("keeps the original when dimensions are missing", async () => {
    asset({ width: undefined, height: 3000 });

    const result = await pickFromLibrary();

    expect(state.manipulate).not.toHaveBeenCalled();
    expect(state.file).toHaveBeenCalledWith(state.asset.uri);
    expect(state.base64).toHaveBeenCalledWith(state.asset.uri);
    expect(result.attachments[0]?.previewUri).toBe("file:///fake/photo.jpg");
  });

  it("does not flatten a GIF", async () => {
    asset({ uri: "file:///fake/photo.gif", fileName: "photo.gif", mimeType: "image/gif" });

    const result = await pickFromLibrary();

    expect(state.manipulate).not.toHaveBeenCalled();
    expect(state.file).toHaveBeenCalledWith(state.asset.uri);
    expect(state.base64).toHaveBeenCalledWith(state.asset.uri);
    expect(result.attachments[0]).toMatchObject({
      name: "photo.gif",
      mimeType: "image/gif",
    });
  });

  it("preserves a large WebP", async () => {
    asset({ uri: "file:///fake/photo.webp", fileName: "photo.webp", mimeType: "image/webp" });

    const result = await pickFromLibrary();

    expect(state.optionalNativeModule).not.toHaveBeenCalled();
    expect(state.manipulate).not.toHaveBeenCalled();
    expect(state.file).toHaveBeenCalledExactlyOnceWith(state.asset.uri);
    expect(state.base64).toHaveBeenCalledExactlyOnceWith(state.asset.uri);
    expect(result.attachments[0]).toMatchObject({
      name: "photo.webp",
      mimeType: "image/webp",
      previewUri: state.asset.uri,
    });
  });

  it.each([0, 1])(
    "does not process over-limit assets with %i slots remaining",
    async (remaining) => {
      state.assets = [state.asset, { ...state.asset, fileName: "extra.jpg" }];

      const result = await pickFromLibrary(ATTACHMENT_MAX_COUNT - remaining);

      expect(state.manipulate).toHaveBeenCalledTimes(remaining);
      expect(state.file).toHaveBeenCalledTimes(remaining);
      expect(state.base64).toHaveBeenCalledTimes(remaining);
      expect(result.attachments).toHaveLength(remaining);
      expect(result.skipped).toEqual(
        state.assets.slice(remaining).map((item) => ({
          name: item.fileName,
          reason: `max ${ATTACHMENT_MAX_COUNT} attachments`,
        })),
      );
    },
  );

  it("keeps a later photo when an oversized photo leaves a slot open", async () => {
    state.assets = [
      state.asset,
      { ...state.asset, fileName: "next.jpg" },
      { ...state.asset, fileName: "extra.jpg" },
    ];
    state.info.mockReturnValueOnce({ size: 100 * 1024 * 1024 }).mockReturnValue({ size: 2 });

    const result = await pickFromLibrary(ATTACHMENT_MAX_COUNT - 1, 50 * 1024 * 1024);
    expect(state.manipulate).toHaveBeenCalledTimes(2);
    expect(state.file).toHaveBeenCalledTimes(2);
    expect(result.attachments[0]?.name).toBe("next.jpg");
    expect(result.skipped).toEqual([
      { name: "photo.jpg", reason: "over 50 MiB" },
      { name: "extra.jpg", reason: `max ${ATTACHMENT_MAX_COUNT} attachments` },
    ]);
  });

  it("keeps the original when manipulation fails", async () => {
    state.manipulate.mockImplementation(() => {
      throw new Error("unsupported image");
    });

    const result = await pickFromLibrary();

    expect(state.file).toHaveBeenCalledExactlyOnceWith(state.asset.uri);
    expect(state.base64).toHaveBeenCalledExactlyOnceWith(state.asset.uri);
    expect(result.attachments[0]).toMatchObject({
      name: "photo.jpg",
      mimeType: "image/jpeg",
      previewUri: "file:///fake/photo.jpg",
    });
  });
});
