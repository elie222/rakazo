import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  moduleAvailable: true,
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
  getPermissionsAsync: vi.fn(async () => state.permission),
  requestPermissionsAsync: state.requestPermission,
}));
vi.mock("./artifact-open", () => ({
  namedArtifactFile: state.named,
  shareLocalFile: state.share,
}));

const load = () => import("./artifact-download");

beforeEach(() => {
  vi.resetModules();
  state.moduleAvailable = true;
  state.permission = { granted: true, canAskAgain: true };
  state.requestPermission.mockResolvedValue({ granted: true, canAskAgain: true });
  state.create.mockReset().mockResolvedValue({});
  state.named.mockClear();
  state.share.mockReset().mockResolvedValue(undefined);
});

describe("downloadArtifactToDevice", () => {
  it("creates a photo-library asset with the artifact's name without opening the share sheet", async () => {
    const api = await load();
    await api.downloadArtifactToDevice("file:///cache/chart.png", "image/png", "chart.png");
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
    await api.downloadArtifactToDevice("file:///clip.mp4", "video/mp4", "clip.mp4");
    expect(state.requestPermission).toHaveBeenCalledWith(true, ["photo", "video"]);
    expect(state.create).toHaveBeenCalledWith("file:///named/clip.mp4");
  });

  it("falls back to the system sheet when permission is denied", async () => {
    state.permission = { granted: false, canAskAgain: false };
    const api = await load();
    await api.downloadArtifactToDevice("file:///chart.png", "image/png", "chart.png");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.share).toHaveBeenCalledWith("file:///chart.png", "image/png", "chart.png");
  });

  it("falls back when saving an unsupported image fails", async () => {
    state.create.mockRejectedValue(new Error("unsupported"));
    const api = await load();
    await api.downloadArtifactToDevice("file:///chart.webp", "image/webp", "chart.webp");
    expect(state.share).toHaveBeenCalledWith("file:///chart.webp", "image/webp", "chart.webp");
  });

  it("uses the share sheet for a build without the native module", async () => {
    state.moduleAvailable = false;
    const api = await load();
    await api.downloadArtifactToDevice("file:///chart.png", "image/png", "chart.png");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.share).toHaveBeenCalled();
  });

  it("uses the share sheet for a non-media artifact", async () => {
    const api = await load();
    await api.downloadArtifactToDevice("file:///brief.pdf", "application/pdf", "brief.pdf");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.share).toHaveBeenCalledWith("file:///brief.pdf", "application/pdf", "brief.pdf");
  });
});
