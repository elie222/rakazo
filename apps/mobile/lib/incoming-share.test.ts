import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  os: "android",
  payloads: [] as Array<{ value: string; shareType: string; mimeType?: string }>,
  resolved: [] as Array<Record<string, unknown>>,
  clear: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
}));
vi.mock("expo-sharing", () => ({
  getSharedPayloads: () => state.payloads,
  getResolvedSharedPayloadsAsync: async () => {
    state.resolve();
    return state.resolved;
  },
  clearSharedPayloads: () => {
    state.clear();
    state.payloads = [];
  },
}));

const { takeIncomingShare } = await import("./incoming-share");

beforeEach(() => {
  state.os = "android";
  state.payloads = [];
  state.resolved = [];
  state.clear.mockClear();
  state.resolve.mockClear();
});

describe("incoming share", () => {
  it("takes shared text once without resolving it", async () => {
    state.payloads = [{ value: " https://example.com/a ", shareType: "url" }];
    expect(await takeIncomingShare()).toEqual({ text: "https://example.com/a", files: [] });
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.clear).toHaveBeenCalledTimes(1);
    expect(await takeIncomingShare()).toBeNull();
  });

  it("returns shared files from their cached copies", async () => {
    state.payloads = [{ value: "content://media/1", shareType: "image", mimeType: "image/png" }];
    state.resolved = [
      {
        value: "content://media/1",
        shareType: "image",
        mimeType: "image/png",
        contentUri: "file:///cache/photo.png",
        contentMimeType: "image/png",
        originalName: "photo.png",
      },
    ];
    const [first, second] = await Promise.all([takeIncomingShare(), takeIncomingShare()]);
    expect(first).toEqual({
      text: "",
      files: [{ uri: "file:///cache/photo.png", name: "photo.png", mimeType: "image/png" }],
    });
    expect(second).toBe(first);
    expect(state.resolve).toHaveBeenCalledTimes(1);
  });

  it("does nothing off Android", async () => {
    state.os = "ios";
    state.payloads = [{ value: "hello", shareType: "text" }];
    expect(await takeIncomingShare()).toBeNull();
    expect(state.clear).not.toHaveBeenCalled();
  });
});
