import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  moduleAvailable: true,
  platform: { OS: "ios", Version: 26 },
  warn: vi.fn(),
  getPermissions: vi.fn(),
  permission: { granted: true, canAskAgain: true },
  requestPermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  create: vi.fn(async () => ({})),
  named: vi.fn((_source: unknown, _mimeType: string, name: string) => ({
    uri: `file:///named/${name}`,
  })),
  share: vi.fn(async () => undefined),
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => (state.moduleAvailable ? {} : null),
}));
vi.mock("react-native", () => ({ Platform: state.platform }));
vi.mock("@rakazo/logging/best-effort", () => ({
  bestEffort: async (label: string, attempt: Promise<unknown>) => {
    try {
      return await attempt;
    } catch (error) {
      state.warn(label, error);
      return undefined;
    }
  },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
  },
}));
vi.mock("expo-media-library", () => ({
  Asset: { create: state.create },
  getPermissionsAsync: state.getPermissions,
  requestPermissionsAsync: state.requestPermission,
}));
vi.mock("./artifact-open", () => ({
  namedArtifactFile: state.named,
  shareLocalFile: state.share,
}));

const load = () => import("./artifact-download");

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.resetModules();
  state.moduleAvailable = true;
  state.platform.OS = "ios";
  state.platform.Version = 26;
  state.warn.mockClear();
  state.getPermissions.mockReset().mockImplementation(async () => state.permission);
  state.permission = { granted: true, canAskAgain: true };
  state.requestPermission.mockResolvedValue({ granted: true, canAskAgain: true });
  state.create.mockReset().mockResolvedValue({});
  state.named.mockClear();
  state.share.mockReset().mockResolvedValue(undefined);
});

describe("downloadArtifactToDevice", () => {
  it("creates a photo-library asset with the artifact's name without opening the share sheet", async () => {
    const api = await load();
    const result = await api.downloadArtifactToDevice(
      "file:///cache/chart.png",
      "image/png",
      "chart.png",
    );
    expect(result).toBe("saved");
    expect(state.named).toHaveBeenCalledWith(
      expect.objectContaining({ uri: "file:///cache/chart.png" }),
      "image/png",
      "chart.png",
    );
    expect(state.create).toHaveBeenCalledWith("file:///named/chart.png");
    expect(state.share).not.toHaveBeenCalled();
  });

  it("asks for write access when the first check is inconclusive", async () => {
    state.permission = { granted: false, canAskAgain: true };
    const api = await load();
    const result = await api.downloadArtifactToDevice("file:///clip.mp4", "video/mp4", "clip.mp4");
    expect(result).toBe("saved");
    expect(state.requestPermission).toHaveBeenCalledWith(true);
    expect(state.create).toHaveBeenCalledWith("file:///named/clip.mp4");
  });

  it("writes through MediaStore on Android 11 without requesting storage access", async () => {
    state.platform.OS = "android";
    state.platform.Version = 30;
    const api = await load();
    await expect(
      api.downloadArtifactToDevice("file:///chart.png", "image/png", "chart.png"),
    ).resolves.toBe("saved");
    expect(state.getPermissions).not.toHaveBeenCalled();
    expect(state.requestPermission).not.toHaveBeenCalled();
  });

  it("falls back to the system sheet when permission is denied", async () => {
    state.permission = { granted: false, canAskAgain: false };
    const api = await load();
    const result = await api.downloadArtifactToDevice(
      "file:///chart.png",
      "image/png",
      "chart.png",
    );
    expect(result).toBe("shared");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.share).toHaveBeenCalledWith("file:///chart.png", "image/png", "chart.png");
  });

  it("logs unexpected saves and falls back when saving an unsupported image fails", async () => {
    state.create.mockRejectedValue(new Error("unsupported"));
    const api = await load();
    const result = await api.downloadArtifactToDevice(
      "file:///chart.webp",
      "image/webp",
      "chart.webp",
    );
    expect(result).toBe("shared");
    expect(state.warn).toHaveBeenCalledWith("Save artifact to photo library", expect.any(Error));
    expect(state.share).toHaveBeenCalledWith("file:///chart.webp", "image/webp", "chart.webp");
  });

  it("uses the share sheet for a build without the native module", async () => {
    state.moduleAvailable = false;
    const api = await load();
    const result = await api.downloadArtifactToDevice(
      "file:///chart.png",
      "image/png",
      "chart.png",
    );
    expect(result).toBe("shared");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.share).toHaveBeenCalled();
  });

  it("uses the share sheet for a non-media artifact", async () => {
    const api = await load();
    const result = await api.downloadArtifactToDevice(
      "file:///brief.pdf",
      "application/pdf",
      "brief.pdf",
    );
    expect(result).toBe("shared");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.share).toHaveBeenCalledWith("file:///brief.pdf", "application/pdf", "brief.pdf");
  });
});
