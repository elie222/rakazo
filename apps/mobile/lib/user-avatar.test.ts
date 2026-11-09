import Module from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { pickUserAvatarImage as PickUserAvatarImage } from "./user-avatar";
import { isUserAvatarImage, toUserAvatarDataUrl } from "./user-avatar";

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
  canceled: false,
  launch: vi.fn(),
  base64: vi.fn(),
  optionalNativeModule: vi.fn(),
  loadManipulator: vi.fn(),
  manipulate: vi.fn(),
  crop: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  save: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(private uri: string) {}
    info() {
      return { size: 1024 };
    }
    base64() {
      return state.base64(this.uri);
    }
  },
}));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: (...args: unknown[]) => state.launch(...args),
}));
vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: state.optionalNativeModule,
}));

// Vitest's ESM mocks do not intercept Metro's CommonJS require.
const nodeModule = Module as unknown as {
  _load: (id: string, ...args: unknown[]) => unknown;
};
const originalLoad = nodeModule._load;

let pickUserAvatarImage: typeof PickUserAvatarImage;

beforeEach(async () => {
  vi.resetModules();
  state.canceled = false;
  state.asset = {
    uri: "file:///fake/photo.jpg",
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    width: 4000,
    height: 3000,
  };
  state.assets = [state.asset];
  state.launch.mockReset().mockImplementation(async () => ({
    canceled: state.canceled,
    assets: state.assets,
  }));
  state.base64.mockReset().mockResolvedValue("aGVsbG8=");
  state.optionalNativeModule.mockReset().mockReturnValue({});
  state.loadManipulator.mockReset().mockImplementation(() => ({
    ImageManipulator: { manipulate: state.manipulate },
    SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
  }));
  vi.spyOn(nodeModule, "_load").mockImplementation((id, ...args) =>
    id === "expo-image-manipulator"
      ? state.loadManipulator(id)
      : originalLoad.call(Module, id, ...args),
  );
  state.manipulate.mockReset();
  state.crop.mockReset();
  state.resize.mockReset();
  state.render.mockReset();
  state.save.mockReset();
  state.manipulate.mockImplementation(() => ({
    crop: state.crop,
    resize: state.resize,
    renderAsync: state.render,
  }));
  state.render.mockResolvedValue({ saveAsync: state.save });
  state.save.mockResolvedValue({ uri: "file:///fake/avatar.webp" });
  ({ pickUserAvatarImage } = await import("./user-avatar"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toUserAvatarDataUrl", () => {
  it("builds a webp data URL and refuses one over the cap", () => {
    expect(toUserAvatarDataUrl("aGVsbG8=")).toBe("data:image/webp;base64,aGVsbG8=");
    expect(toUserAvatarDataUrl("x".repeat(200_000))).toBeNull();
  });
});

describe("isUserAvatarImage", () => {
  it("accepts data-URL images only", () => {
    expect(isUserAvatarImage("data:image/webp;base64,aGVsbG8=")).toBe(true);
    expect(isUserAvatarImage("#F97316")).toBe(false);
    expect(isUserAvatarImage(null)).toBe(false);
    expect(isUserAvatarImage(undefined)).toBe(false);
    expect(isUserAvatarImage(`data:image/webp;base64,${"x".repeat(200_000)}`)).toBe(false);
  });
});

describe("pickUserAvatarImage", () => {
  it("center-crops to a square and saves a 256x256 webp", async () => {
    const result = await pickUserAvatarImage();
    expect(result).toEqual({
      status: "picked",
      image: "data:image/webp;base64,aGVsbG8=",
    });
    expect(state.crop).toHaveBeenCalledWith({
      originX: 500,
      originY: 0,
      width: 3000,
      height: 3000,
    });
    expect(state.resize).toHaveBeenCalledWith({ width: 256, height: 256 });
    expect(state.save).toHaveBeenCalledWith({ compress: 0.8, format: "webp" });
  });

  it("reports a canceled pick", async () => {
    state.canceled = true;
    expect(await pickUserAvatarImage()).toEqual({ status: "canceled" });
    expect(state.manipulate).not.toHaveBeenCalled();
  });

  it("keeps the original file when the resizer is unavailable", async () => {
    state.optionalNativeModule.mockReturnValue(null);
    const result = await pickUserAvatarImage();
    expect(result).toEqual({
      status: "picked",
      image: "data:image/jpeg;base64,aGVsbG8=",
    });
    expect(state.manipulate).not.toHaveBeenCalled();
  });

  it("reports too-large when even the low-quality webp exceeds the cap", async () => {
    state.base64.mockResolvedValue("x".repeat(200_000));
    expect(await pickUserAvatarImage()).toEqual({ status: "error", reason: "too-large" });
    expect(state.save).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable when the picker throws", async () => {
    state.launch.mockRejectedValue(new Error("denied"));
    expect(await pickUserAvatarImage()).toEqual({ status: "error", reason: "unavailable" });
  });
});
