// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api";
import { rpc } from "./api";
import { useThreadSnapshot } from "./thread-history";
import type { ThreadListScroll } from "./thread-list-scroll";
import { useThreadPaging } from "./thread-paging";

vi.mock("./api", () => ({ rpc: vi.fn(), prependMobileMessagePage: vi.fn() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./user-error", () => ({ errorText: (_error: unknown, fallback: string) => fallback }));
vi.mock("./response-streaming", () => ({
  getCachedResponseStreamingEnabled: () => false,
  subscribeResponseStreaming: () => () => {},
}));

const snapshot: MobileSnapshot = {
  threadId: "thread-1",
  cursor: 2,
  olderCursor: 1,
  run: null,
  messages: [],
};

function deferred() {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

function mount() {
  const probe = {} as {
    history: ReturnType<typeof useThreadSnapshot>;
    paging: ReturnType<typeof useThreadPaging>;
  };
  const setError = vi.fn();
  let botId = "bot-1";
  function Probe() {
    const history = useThreadSnapshot();
    const paging = useThreadPaging({
      history,
      scroll: {} as ThreadListScroll,
      botId,
      visibleMessages: [],
      anchor: 0,
      setError,
      showLatest: vi.fn(),
    });
    probe.history = history;
    probe.paging = paging;
    return null;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => probe.history.commitSnap(snapshot));
  return {
    probe,
    setError,
    switchThread() {
      act(() => {
        botId = "bot-2";
        // The live thread switch invalidates pending history before committing its snapshot.
        probe.history.historyEpoch.current += 1;
        probe.history.commitSnap({ ...snapshot, threadId: "thread-2" });
        root.render(<Probe />);
      });
    },
    unmount() {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

describe("mobile older message paging", () => {
  beforeEach(() => {
    vi.mocked(rpc).mockReset();
  });
  it("ignores a failure after clearing and still reports a later current failure", async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(rpc).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { probe, setError, unmount } = mount();
    try {
      let pending!: Promise<void>;
      act(() => {
        pending = probe.paging.loadOlderMessages();
      });
      act(() => probe.history.clear());
      await act(async () => {
        first.reject(new Error("failed"));
        await pending;
      });
      expect(setError).not.toHaveBeenCalled();
      expect(probe.history.snap?.messages).toEqual([]);
      expect(probe.history.snap?.olderCursor).toBeNull();
      expect(probe.paging.loadingOlder).toBe(false);
      expect(probe.history.loadingOlderContent.current).toBe(false);

      act(() => probe.history.commitSnap(snapshot));
      act(() => {
        pending = probe.paging.loadOlderMessages();
      });
      await act(async () => {
        second.reject(new Error("failed"));
        await pending;
      });
      expect(setError).toHaveBeenCalledExactlyOnceWith("Could not load earlier messages");
    } finally {
      unmount();
    }
  });

  it("ignores a failure after switching threads", async () => {
    const request = deferred();
    vi.mocked(rpc).mockReturnValueOnce(request.promise);
    const { probe, setError, switchThread, unmount } = mount();
    try {
      let pending!: Promise<void>;
      act(() => {
        pending = probe.paging.loadOlderMessages();
      });
      switchThread();
      await act(async () => {
        request.reject(new Error("failed"));
        await pending;
      });
      expect(setError).not.toHaveBeenCalled();
      expect(probe.history.snap?.threadId).toBe("thread-2");
      expect(probe.paging.loadingOlder).toBe(false);
      expect(probe.history.loadingOlderContent.current).toBe(false);
    } finally {
      unmount();
    }
  });

  it("ignores a failure after the pinned window changes", async () => {
    const request = deferred();
    vi.mocked(rpc).mockReturnValueOnce(request.promise);
    const { probe, setError, unmount } = mount();
    try {
      let pending!: Promise<void>;
      act(() => {
        pending = probe.paging.loadOlderMessages();
      });
      act(() => {
        probe.history.pinnedAroundRef.current = {
          messageId: "other",
          threadId: "thread-1",
          newerCursor: null,
        };
      });
      await act(async () => {
        request.reject(new Error("failed"));
        await pending;
      });
      expect(setError).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});
