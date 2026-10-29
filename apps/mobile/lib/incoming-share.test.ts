import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  os: "android",
  payloads: [] as Array<{ value: string; shareType: string; mimeType?: string }>,
  clear: vi.fn(),
  copy: vi.fn(),
  size: 3 as number | undefined,
  remove: vi.fn(),
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
  clearSharedPayloads: () => {
    state.clear();
    state.payloads = [];
  },
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache/" },
  File: class {
    uri: string;
    exists = true;
    name = "photo.png";
    type = "image/png";
    constructor(...parts: string[]) {
      this.uri = parts.join("/");
    }
    info() {
      return { size: state.size };
    }
    async copy(to: { uri: string }) {
      state.copy(this.uri, to.uri);
    }
    delete() {
      state.remove(this.uri);
    }
  },
}));
const {
  isIncomingShareCurrent,
  receiveIncomingShare,
  takeIncomingShare,
  cancelIncomingShare,
  hasIncomingShare,
  readIncomingShareFile,
  retryIncomingShare,
} = await import("./incoming-share");

beforeEach(() => {
  vi.useFakeTimers();
  state.os = "android";
  cancelIncomingShare();
  state.payloads = [];
  vi.clearAllMocks();
  state.size = 3;
});
afterEach(() => {
  cancelIncomingShare();
  vi.useRealTimers();
});
function receive() {
  state.payloads = [{ value: " https://example.com/a ", shareType: "url" }];
  receiveIncomingShare(true, false);
}
describe("incoming share", () => {
  it("takes text once without copying files", () => {
    receive();
    expect(takeIncomingShare()?.text).toBe("https://example.com/a");
    expect(takeIncomingShare()).toBeNull();
    expect(state.copy).not.toHaveBeenCalled();
  });
  it("cancel clears and prevents a failed in-flight import reviving it", () => {
    receive();
    const share = takeIncomingShare()!;
    cancelIncomingShare();
    retryIncomingShare(share);
    expect(isIncomingShareCurrent(share)).toBe(false);
    expect(hasIncomingShare()).toBe(false);
    expect(takeIncomingShare()).toBeNull();
    expect(state.payloads).toEqual([]);
  });
  it("expires after five minutes", () => {
    receive();
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(hasIncomingShare()).toBe(false);
    expect(takeIncomingShare()).toBeNull();
  });
  it("checks age on take even if the expiry timer was suspended", () => {
    receive();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    expect(takeIncomingShare()).toBeNull();
  });
  it("cold starting without a share clears old native state", () => {
    receive();
    receiveIncomingShare(false, true);
    expect(takeIncomingShare()).toBeNull();
    expect(state.payloads).toEqual([]);
  });
  it("keeps a share on ordinary navigation", () => {
    receive();
    receiveIncomingShare(false, false);
    expect(hasIncomingShare()).toBe(true);
  });
  it("does nothing off Android", () => {
    state.os = "ios";
    receive();
    expect(takeIncomingShare()).toBeNull();
    expect(state.clear).not.toHaveBeenCalled();
  });
  it("retries failures without replacing a newer share", () => {
    receive();
    const share = takeIncomingShare()!;
    retryIncomingShare(share);
    expect(takeIncomingShare()).toBe(share);
    receive();
    retryIncomingShare(share);
    expect(takeIncomingShare()).not.toBe(share);
  });
  it("deletes only its cache copy after consumption", async () => {
    await readIncomingShareFile("content://media/1", 1024, async (file) => {
      expect(state.remove).not.toHaveBeenCalled();
      expect(file.uri).toContain("file:///cache/");
    });
    expect(state.remove).toHaveBeenCalledWith(state.copy.mock.calls[0]?.[1]);
    expect(state.remove).not.toHaveBeenCalledWith("content://media/1");
  });
  it("cleans the copy when a read fails or cancellation happens during reading", async () => {
    await expect(
      readIncomingShareFile("content://media/1", 1024, async () => {
        cancelIncomingShare();
        throw new Error("unreadable");
      }),
    ).rejects.toThrow("unreadable");
    expect(state.remove).toHaveBeenCalledTimes(1);
  });
  it("rejects known oversized files without copying", async () => {
    state.size = 2048;
    expect(await readIncomingShareFile("content://media/1", 1024, vi.fn())).toBeNull();
    expect(state.copy).not.toHaveBeenCalled();
  });
  it("refuses unknown-size copies instead of copying an unbounded stream", async () => {
    state.size = undefined;
    await expect(readIncomingShareFile("content://media/1", 1024, vi.fn())).rejects.toThrow(
      "Shared file size is unavailable",
    );
    expect(state.copy).not.toHaveBeenCalled();
  });
  it("does not copy files while waiting, cancelling or expiring", () => {
    state.payloads = [{ value: "content://media/1", shareType: "image" }];
    receiveIncomingShare(true, true);
    cancelIncomingShare();
    expect(state.copy).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });
});
