import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  os: "android",
  payloads: [] as Array<{ value: string; shareType: string; mimeType?: string }>,
  clear: vi.fn(),
  copy: vi.fn(),
  size: 3 as number | undefined,
  remove: vi.fn(),
  // The iOS app group container; null on Android and on iOS builds without the extension.
  container: null as { uri: string; files: string[] } | null,
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
vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    exists = true;
    type = "image/png";
    constructor(...parts: string[]) {
      this.uri = parts.join("/");
    }
    get name() {
      return this.uri.split("/").pop() ?? "";
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
  }
  return {
    File,
    Paths: {
      cache: "file:///cache/",
      get appleSharedContainers() {
        const container = state.container;
        if (!container) return {};
        return {
          "group.com.rakazo.app": {
            uri: container.uri,
            list: () => container.files.map((name) => new File(`${container.uri}${name}`)),
          },
        };
      },
    },
  };
});
const {
  isIncomingShareCurrent,
  receiveIncomingShare,
  takeIncomingShare,
  cancelIncomingShare,
  hasIncomingShare,
  readIncomingShareFile,
  releaseIncomingShareFiles,
  retryIncomingShare,
} = await import("./incoming-share");

beforeEach(() => {
  vi.useFakeTimers();
  state.os = "android";
  state.container = null;
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
  it("does nothing on iOS builds without the share extension", () => {
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

const GROUP = "file:///group/";
function receiveIos(names: string[], initial = false) {
  state.payloads = names.map((name) => ({ value: `${GROUP}${name}`, shareType: "image" }));
  receiveIncomingShare(true, initial);
}
describe("incoming share on iOS", () => {
  beforeEach(() => {
    state.os = "ios";
    state.container = { uri: GROUP, files: [] };
  });
  it("receives files the extension copied and hands them off once", () => {
    receiveIos(["a.png", "b.pdf"]);
    expect(takeIncomingShare()?.files.map((file) => file.name)).toEqual(["a.png", "b.pdf"]);
    expect(takeIncomingShare()).toBeNull();
    expect(state.clear).toHaveBeenCalled();
  });
  it("deletes the extension's copies when the share is cancelled or expires", () => {
    receiveIos(["a.png"]);
    cancelIncomingShare();
    expect(state.remove).toHaveBeenCalledWith(`${GROUP}a.png`);
    state.remove.mockClear();
    receiveIos(["b.png"]);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(state.remove).toHaveBeenCalledWith(`${GROUP}b.png`);
  });
  it("deletes an expired share's copies when it is taken late", () => {
    receiveIos(["a.png"]);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    expect(takeIncomingShare()).toBeNull();
    expect(state.remove).toHaveBeenCalledWith(`${GROUP}a.png`);
  });
  it("keeps files put back for retry and those a newer share reuses", () => {
    receiveIos(["a.png", "b.png"]);
    const share = takeIncomingShare()!;
    retryIncomingShare({ ...share, files: share.files.slice(1) });
    releaseIncomingShareFiles(share.files);
    expect(state.remove.mock.calls).toEqual([[`${GROUP}a.png`]]);
    state.remove.mockClear();
    // The extension names its copy after the file, so a newer share can reuse the same path.
    receiveIos(["b.png"]);
    expect(state.remove).not.toHaveBeenCalled();
    retryIncomingShare(share);
    expect(state.remove.mock.calls).toEqual([[`${GROUP}a.png`]]);
  });
  it("never deletes outside the share container", () => {
    releaseIncomingShareFiles([{ uri: "file:///elsewhere/a.png", name: "a.png", mimeType: null }]);
    expect(state.remove).not.toHaveBeenCalled();
  });
  it("sweeps leftovers on a cold start, keeping the share it opened with", () => {
    state.container!.files = [
      ".com.apple.mobile_container_manager.metadata.plist",
      "old.png",
      "new.png",
    ];
    receiveIos(["new.png"], true);
    expect(state.remove.mock.calls).toEqual([[`${GROUP}old.png`]]);
    state.remove.mockClear();
    cancelIncomingShare();
    state.remove.mockClear();
    state.container!.files = ["old.png"];
    receiveIncomingShare(false, true);
    expect(state.remove.mock.calls).toEqual([[`${GROUP}old.png`]]);
  });
  it("does not sweep on a warm share, while another import may be reading", () => {
    state.container!.files = ["in-flight.png"];
    receiveIos(["new.png"]);
    expect(state.remove).not.toHaveBeenCalled();
  });
});
