// @vitest-environment jsdom

import type * as CoreModule from "@rakazo/core";
import { reduceThreadSnapshot } from "@rakazo/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api";
import { rpc, subscribeThread } from "./api";
import { hapticSuccess } from "./haptics";
import type { ThreadJumpAnchor } from "./thread-jump";
import { useThreadLiveSubscription } from "./thread-live";
import type { PinnedThreadWindow } from "./thread-window";

vi.mock("./api", () => ({
  rpc: vi.fn(),
  subscribeThread: vi.fn(),
}));
vi.mock("@rakazo/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  reduceThreadSnapshot: vi.fn(),
}));
const session = vi.hoisted(() => ({ generation: 1 }));
vi.mock("./session", () => ({ currentSessionGeneration: () => session.generation }));
vi.mock("./user-error", () => ({ errorText: String }));
// The member status test runs the real reducer; keep its native imports out of jsdom.
vi.mock("./ai-consent", () => ({}));
vi.mock("./live-notifications", () => ({}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("./haptics", () => ({ getHapticsEnabled: () => true, hapticSuccess: vi.fn() }));

type LiveEvent = { type: string; seq: number; runId?: string };
const ref = <T>(current: T) => ({ current });

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  session.generation = 1;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("thread foreground subscription", () => {
  it("retains a trailing snapshot after a burst and skips it if history opens", async () => {
    const snapshot = { cursor: 10 } as MobileSnapshot;
    let deliver: (event: LiveEvent) => void = () => {};
    let finish!: (value: MobileSnapshot) => void;
    const pending = new Promise<MobileSnapshot>((resolve) => {
      finish = resolve;
    });
    vi.mocked(subscribeThread).mockImplementation(async (_target, _cursor, onEvent, signal) => {
      deliver = onEvent as unknown as typeof deliver;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
    });
    vi.mocked(reduceThreadSnapshot).mockReturnValue(snapshot);
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(pending)
      .mockResolvedValue(snapshot);
    const expandedHistoryThread = ref<string | null>(null);
    const refreshMentionBots = vi.fn(async () => {});
    const root = createRoot(document.createElement("div"));
    function Probe() {
      useThreadLiveSubscription({
        botId: "bot-1",
        foreground: true,
        readOnly: false,
        sessionEpoch: 1,
        historyEpoch: ref(0),
        expandedHistoryThread,
        pinnedAroundRef: ref(null),
        jumpScrollTarget: ref(null),
        jumpAnchor: ref({ release: vi.fn() } as unknown as ThreadJumpAnchor),
        snapRef: ref(snapshot),
        terminalRunIds: ref(new Set<string>()),
        readVisibleTarget: ref(null),
        showSavedThread: vi.fn(),
        refresh,
        commitSnap: vi.fn(),
        setError: vi.fn(),
        refreshMentionBots,
        markReadIfVisible: vi.fn(),
      });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    refresh.mockClear();
    deliver({ type: "run.waiting_input", seq: 11 });
    await act(async () => {});
    for (let i = 0; i < 100; i++) deliver({ type: "run.waiting_input", seq: 12 + i });
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(1);
    finish(snapshot);
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(2);
    // The guard is checked when the queued read starts, not just when it was requested.
    deliver({ type: "run.waiting_input", seq: 112 });
    expandedHistoryThread.current = "thread-1";
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(2);
    expandedHistoryThread.current = null;
    deliver({ type: "run.waiting_input", seq: 113 });
    session.generation += 1;
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refreshMentionBots).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("keeps group member status right in older history, where no refresh corrects it", async () => {
    const actual = await vi.importActual<typeof CoreModule>("@rakazo/core");
    vi.mocked(reduceThreadSnapshot).mockImplementation(actual.reduceThreadSnapshot);
    vi.mocked(rpc).mockResolvedValue({ cursor: 10, threadId: "thread-1" } as never);
    let deliver: (event: LiveEvent & { botId?: string; createdAt?: string }) => void = () => {};
    vi.mocked(subscribeThread).mockImplementation(async (_target, _cursor, onEvent, signal) => {
      deliver = onEvent as unknown as typeof deliver;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
    });
    const snapRef = ref<MobileSnapshot | null>({
      groupId: "group-1",
      threadId: "thread-1",
      cursor: 10,
      messages: [],
      olderCursor: 1,
      run: null,
      activeRuns: [],
      members: [{ botId: "bot-1", name: "Writer", color: "blue", status: "idle" }],
    } as unknown as MobileSnapshot);
    const commitSnap = vi.fn((next: MobileSnapshot | null) => {
      snapRef.current = next;
    });
    const refresh = vi.fn(async () => snapRef.current ?? undefined);
    const root = createRoot(document.createElement("div"));
    function Probe() {
      useThreadLiveSubscription({
        groupId: "group-1",
        foreground: true,
        focused: true,
        readOnly: false,
        sessionEpoch: 1,
        historyEpoch: ref(0),
        expandedHistoryThread: ref<string | null>("thread-1"),
        pinnedAroundRef: ref(null),
        jumpScrollTarget: ref(null),
        jumpAnchor: ref({ release: vi.fn() } as unknown as ThreadJumpAnchor),
        snapRef,
        terminalRunIds: ref(new Set<string>()),
        readVisibleTarget: ref(null),
        showSavedThread: vi.fn(),
        refresh,
        commitSnap,
        setError: vi.fn(),
        refreshMentionBots: vi.fn(async () => {}),
        markReadIfVisible: vi.fn(),
      });
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    refresh.mockClear();
    const status = () => snapRef.current?.members?.[0]?.status;

    deliver({ type: "run.started", seq: 11, botId: "bot-1", runId: "run-1" });
    expect(status()).toBe("running");
    deliver({ type: "run.waiting_input", seq: 12, botId: "bot-1", runId: "run-1" });
    await act(async () => {});
    expect(status()).toBe("waiting_input");
    deliver({ type: "run.started", seq: 13, botId: "bot-1", runId: "run-1" });
    deliver({
      type: "run.completed",
      seq: 14,
      botId: "bot-1",
      runId: "run-1",
      createdAt: new Date().toISOString(),
    });
    await act(async () => {});
    expect(status()).toBe("idle");
    expect(snapRef.current?.run).toBeNull();
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("confirms live completions once and suppresses failures, hidden chats and catch-up events", async () => {
    const actual = await vi.importActual<typeof CoreModule>("@rakazo/core");
    vi.mocked(reduceThreadSnapshot).mockImplementation(actual.reduceThreadSnapshot);
    type Event = Parameters<Parameters<typeof subscribeThread>[2]>[0];
    let deliver: (event: Event) => void = () => {};
    vi.mocked(subscribeThread).mockImplementation(async (_target, _cursor, onEvent, signal) => {
      deliver = onEvent;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
    });
    const snapRef = ref<MobileSnapshot | null>({
      botId: "bot-1",
      threadId: "thread-1",
      cursor: 10,
      messages: [],
      run: null,
      activeRuns: [],
    } as unknown as MobileSnapshot);
    const refresh = vi.fn(async () => snapRef.current ?? undefined);
    let headCursor = 10;
    let pendingHead: Promise<{ cursor: number; threadId: string }> | undefined;
    vi.mocked(rpc).mockImplementation(
      async () => (pendingHead ?? { cursor: headCursor, threadId: "thread-1" }) as never,
    );
    const refreshMentionBots = vi.fn(async () => {});
    const markReadIfVisible = vi.fn();
    const root = createRoot(document.createElement("div"));
    function Probe({ focused, foreground }: { focused: boolean; foreground: boolean }) {
      useThreadLiveSubscription({
        botId: "bot-1",
        focused,
        foreground,
        readOnly: false,
        sessionEpoch: 1,
        historyEpoch: ref(0),
        expandedHistoryThread: ref("thread-1"),
        pinnedAroundRef: ref(null),
        jumpScrollTarget: ref(null),
        jumpAnchor: ref({ release: vi.fn() } as unknown as ThreadJumpAnchor),
        snapRef,
        terminalRunIds: ref(new Set<string>()),
        readVisibleTarget: ref(null),
        showSavedThread: vi.fn(),
        refresh,
        commitSnap: (next) => {
          snapRef.current = next;
        },
        setError: vi.fn(),
        refreshMentionBots,
        markReadIfVisible,
      });
      return null;
    }
    const render = (focused: boolean, foreground = true) =>
      act(async () => root.render(createElement(Probe, { focused, foreground })));
    await render(true);
    refresh.mockClear();
    const event = (type: string, seq: number, runId: string): Event => ({
      type,
      seq,
      runId,
      botId: "bot-1",
      // Device and server clocks can disagree in either direction.
      createdAt: seq % 2 ? "1970-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
    });
    deliver(event("run.started", 11, "run-1"));
    deliver(event("thread.progress", 12, "run-1"));
    expect(hapticSuccess).not.toHaveBeenCalled();
    deliver(event("run.completed", 13, "run-1"));
    expect(snapRef.current?.run).toBeNull();
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
    deliver(event("run.completed", 13, "run-1"));
    deliver(event("run.completed", 14, "run-1"));
    deliver(event("run.failed", 15, "run-2"));
    deliver(event("run.cancelled", 16, "run-3"));
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
    await render(false);
    expect(subscribeThread).toHaveBeenCalledTimes(1);
    deliver(event("run.completed", 18, "hidden-run"));
    let finishHead!: (head: { cursor: number; threadId: string }) => void;
    pendingHead = new Promise((resolve) => {
      finishHead = resolve;
    });
    await render(true);
    expect(subscribeThread).toHaveBeenCalledTimes(1);
    deliver(event("run.completed", 19, "pending-head-run"));
    deliver(event("run.completed", 19, "pending-head-run"));
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
    await act(async () => finishHead({ cursor: 18, threadId: "thread-1" }));
    pendingHead = undefined;
    expect(hapticSuccess).toHaveBeenCalledTimes(2);
    deliver(event("run.completed", 20, "pending-head-run"));
    expect(hapticSuccess).toHaveBeenCalledTimes(2);
    headCursor = 21;
    await render(true, false);
    deliver(event("run.completed", 21, "aborted-stream"));
    await render(true);
    deliver(event("run.completed", 21, "background-run"));
    expect(hapticSuccess).toHaveBeenCalledTimes(2);
    deliver(event("run.started", 22, "run-4"));
    deliver(event("run.completed", 23, "run-4"));
    expect(hapticSuccess).toHaveBeenCalledTimes(3);
    await act(async () => {});
    expect(refresh).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it.each([false, true])(
    "replays feedback without rewinding a newer snapshot (head retry %s)",
    async (retryHead) => {
      if (retryHead) vi.useFakeTimers();
      const actual = await vi.importActual<typeof CoreModule>("@rakazo/core");
      vi.mocked(reduceThreadSnapshot).mockImplementation(actual.reduceThreadSnapshot);
      type Event = Parameters<Parameters<typeof subscribeThread>[2]>[0];
      let deliver: (event: Event) => void = () => {};
      const cursors: number[] = [];
      vi.mocked(subscribeThread).mockImplementation(async (_target, cursor, onEvent, signal) => {
        cursors.push(cursor);
        deliver = onEvent;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      });
      let finishHead!: (head: { cursor: number; threadId: string }) => void;
      const head = new Promise<{ cursor: number; threadId: string }>((resolve) => {
        finishHead = resolve;
      });
      vi.mocked(rpc).mockImplementation(async () => head as never);
      if (retryHead) {
        vi.mocked(rpc).mockRejectedValueOnce(
          Object.assign(new Error("Unavailable"), { status: 503 }),
        );
      }
      let finishRefresh!: (snapshot: MobileSnapshot) => void;
      const initial = new Promise<MobileSnapshot>((resolve) => {
        finishRefresh = resolve;
      });
      const snapshot = {
        botId: "bot-1",
        threadId: "thread-1",
        cursor: 15,
        olderCursor: null,
        messages: [{ id: "newer-message", role: "bot", blocks: [{ kind: "text", text: "Done" }] }],
        run: null,
        activeRuns: [],
      } as MobileSnapshot;
      const snapRef = ref<MobileSnapshot | null>(snapshot);
      const commitSnap = vi.fn((next: MobileSnapshot | null) => {
        snapRef.current = next;
      });
      const refresh = vi.fn(() => initial);
      const refreshMentionBots = vi.fn(async () => {});
      const markReadIfVisible = vi.fn();
      const root = createRoot(document.createElement("div"));
      function Probe({ foreground }: { foreground: boolean }) {
        useThreadLiveSubscription({
          botId: "bot-1",
          focused: true,
          foreground,
          readOnly: false,
          sessionEpoch: 1,
          historyEpoch: ref(0),
          expandedHistoryThread: ref("thread-1"),
          pinnedAroundRef: ref(null),
          jumpScrollTarget: ref(null),
          jumpAnchor: ref({ release: vi.fn() } as unknown as ThreadJumpAnchor),
          snapRef,
          terminalRunIds: ref(new Set<string>()),
          readVisibleTarget: ref(null),
          showSavedThread: vi.fn(),
          refresh,
          commitSnap,
          setError: vi.fn(),
          refreshMentionBots,
          markReadIfVisible,
        });
        return null;
      }
      try {
        await act(async () => root.render(createElement(Probe, { foreground: true })));
        if (retryHead) await act(async () => vi.advanceTimersByTimeAsync(250));
        await act(async () => finishHead({ cursor: 10, threadId: "thread-1" }));
        expect(subscribeThread).not.toHaveBeenCalled();
        await act(async () => finishRefresh(snapshot));
        expect(cursors).toEqual([10]);
        const event = (type: string, seq: number, runId: string): Event => ({
          type,
          seq,
          runId,
          botId: "bot-1",
          createdAt: "1970-01-01T00:00:00Z",
        });
        deliver(event("run.completed", 9, "historical-run"));
        deliver(event("run.started", 11, "covered-run"));
        deliver(event("run.completed", 12, "covered-run"));
        expect(snapRef.current).toBe(snapshot);
        await act(async () => root.render(createElement(Probe, { foreground: false })));
        vi.mocked(rpc).mockResolvedValue({ cursor: 15, threadId: "thread-1" } as never);
        await act(async () => root.render(createElement(Probe, { foreground: true })));
        expect(cursors).toEqual([10, 12]);
        deliver(event("thread.cleared", 13, "covered-run"));
        deliver(event("run.completed", 14, "covered-run"));
        deliver(event("run.started", 15, "covered-run"));
        expect(hapticSuccess).toHaveBeenCalledTimes(1);
        expect(reduceThreadSnapshot).not.toHaveBeenCalled();
        expect(commitSnap).not.toHaveBeenCalled();
        expect(snapRef.current).toBe(snapshot);
        deliver(event("run.started", 16, "live-run"));
        deliver(event("run.completed", 17, "live-run"));
        expect(hapticSuccess).toHaveBeenCalledTimes(2);
        expect(snapRef.current?.cursor).toBe(17);
        expect(snapRef.current?.run).toBeNull();
        expect(snapRef.current?.messages).toEqual(snapshot.messages);
        expect(commitSnap).toHaveBeenCalledTimes(2);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("marks snapshot-covered bot messages read without projecting replay over the snapshot", async () => {
    type Event = Parameters<Parameters<typeof subscribeThread>[2]>[0];
    let deliver!: (event: Event) => void;
    vi.mocked(subscribeThread).mockImplementation(async (_target, _cursor, onEvent, signal) => {
      deliver = onEvent;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
    });
    vi.mocked(rpc).mockResolvedValue({ cursor: 10, threadId: "thread-1" } as never);
    const snapshot = { cursor: 15 } as MobileSnapshot;
    const snapRef = ref<MobileSnapshot | null>(snapshot);
    const readVisibleTarget = ref<string | null>("bot-1");
    const markReadIfVisible = vi.fn();
    const refreshMentionBots = vi.fn(async () => {});
    const refresh = vi.fn(async () => snapshot);
    const commitSnap = vi.fn();
    const root = createRoot(document.createElement("div"));
    function Probe() {
      useThreadLiveSubscription({
        botId: "bot-1",
        focused: true,
        foreground: true,
        readOnly: false,
        sessionEpoch: 1,
        historyEpoch: ref(0),
        expandedHistoryThread: ref(null),
        pinnedAroundRef: ref(null),
        jumpScrollTarget: ref(null),
        jumpAnchor: ref({ release: vi.fn() } as unknown as ThreadJumpAnchor),
        snapRef,
        terminalRunIds: ref(new Set<string>()),
        readVisibleTarget,
        showSavedThread: vi.fn(),
        refresh,
        commitSnap,
        setError: vi.fn(),
        refreshMentionBots,
        markReadIfVisible,
      });
      return null;
    }
    try {
      await act(async () => root.render(createElement(Probe)));
      expect(subscribeThread).toHaveBeenCalledWith(
        { botId: "bot-1" },
        10,
        expect.anything(),
        expect.anything(),
      );
      deliver({
        type: "thread.message.created",
        seq: 13,
        botId: "bot-1",
        createdAt: "1970-01-01T00:00:00Z",
        payload: { role: "bot" },
      });
      expect(markReadIfVisible).toHaveBeenCalledOnce();
      expect(readVisibleTarget.current).toBeNull();
      deliver({ type: "bot.updated", seq: 14, botId: "bot-1", createdAt: "1970-01-01T00:00:00Z" });
      expect(refreshMentionBots).toHaveBeenCalledOnce();
      expect(reduceThreadSnapshot).not.toHaveBeenCalled();
      expect(commitSnap).not.toHaveBeenCalled();
      expect(snapRef.current).toBe(snapshot);
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([503, 403])(
    "bounds a slow feedback lookup and handles HTTP %s without holding up chat",
    async (status) => {
      vi.useFakeTimers();
      const actual = await vi.importActual<typeof CoreModule>("@rakazo/core");
      vi.mocked(reduceThreadSnapshot).mockImplementation(actual.reduceThreadSnapshot);
      type Event = Parameters<Parameters<typeof subscribeThread>[2]>[0];
      let deliver: (event: Event) => void = () => {};
      vi.mocked(subscribeThread).mockImplementation(async (_target, _cursor, onEvent, signal) => {
        deliver = onEvent;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      });
      let failFirst!: (error: Error) => void;
      const first = new Promise<never>((_resolve, reject) => {
        failFirst = reject;
      });
      let finishRetry!: (head: { cursor: number; threadId: string }) => void;
      const retry = new Promise<{ cursor: number; threadId: string }>((resolve) => {
        finishRetry = resolve;
      });
      // The first request deliberately ignores timeoutMs so the bootstrap bound is independent.
      vi.mocked(rpc)
        .mockImplementationOnce(async () => first)
        .mockImplementation(async () => retry as never);
      const snapRef = ref<MobileSnapshot | null>({
        botId: "bot-1",
        threadId: "thread-1",
        cursor: 10,
        olderCursor: null,
        messages: [],
        run: null,
        activeRuns: [],
      } as MobileSnapshot);
      const refresh = vi.fn(async () => snapRef.current ?? undefined);
      const root = createRoot(document.createElement("div"));
      function Probe() {
        useThreadLiveSubscription({
          botId: "bot-1",
          focused: true,
          foreground: true,
          readOnly: false,
          sessionEpoch: 1,
          historyEpoch: ref(0),
          expandedHistoryThread: ref("thread-1"),
          pinnedAroundRef: ref(null),
          jumpScrollTarget: ref(null),
          jumpAnchor: ref({ release: vi.fn() } as unknown as ThreadJumpAnchor),
          snapRef,
          terminalRunIds: ref(new Set<string>()),
          readVisibleTarget: ref(null),
          showSavedThread: vi.fn(),
          refresh,
          commitSnap: (next) => {
            snapRef.current = next;
          },
          setError: vi.fn(),
          refreshMentionBots: vi.fn(async () => {}),
          markReadIfVisible: vi.fn(),
        });
        return null;
      }
      const complete = (seq: number, runId: string): Event => ({
        type: "run.completed",
        seq,
        runId,
      });
      try {
        await act(async () => root.render(createElement(Probe)));
        expect(subscribeThread).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTimeAsync(249));
        expect(subscribeThread).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(subscribeThread).toHaveBeenCalledExactlyOnceWith(
          { botId: "bot-1" },
          10,
          expect.any(Function),
          expect.any(AbortSignal),
        );
        deliver(complete(11, "failed-window"));
        expect(snapRef.current?.cursor).toBe(11);
        expect(hapticSuccess).not.toHaveBeenCalled();
        await act(async () => failFirst(Object.assign(new Error("Unavailable"), { status })));
        if (status === 403) {
          await act(async () => vi.advanceTimersByTimeAsync(10_000));
          expect(rpc).toHaveBeenCalledTimes(1);
          deliver(complete(12, "after-refusal"));
          expect(hapticSuccess).not.toHaveBeenCalled();
          return;
        }
        await act(async () => vi.advanceTimersByTimeAsync(249));
        expect(rpc).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(rpc).toHaveBeenCalledTimes(2);
        deliver(complete(12, "retry-catch-up"));
        await act(async () => finishRetry({ cursor: 12, threadId: "thread-1" }));
        expect(hapticSuccess).not.toHaveBeenCalled();
        deliver(complete(12, "retry-catch-up"));
        deliver(complete(13, "live-after-retry"));
        expect(hapticSuccess).toHaveBeenCalledTimes(1);
        deliver(complete(14, "live-after-retry"));
        expect(hapticSuccess).toHaveBeenCalledTimes(1);
        expect(subscribeThread).toHaveBeenCalledTimes(1);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("recovers feedback on a 500 ms connection without delaying live chat or refocusing", async () => {
    vi.useFakeTimers();
    const actual = await vi.importActual<typeof CoreModule>("@rakazo/core");
    vi.mocked(reduceThreadSnapshot).mockImplementation(actual.reduceThreadSnapshot);
    type Event = Parameters<Parameters<typeof subscribeThread>[2]>[0];
    let deliver: (event: Event) => void = () => {};
    vi.mocked(subscribeThread).mockImplementation(async (_target, _cursor, onEvent, signal) => {
      deliver = onEvent;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
    });
    let headCursor = 10;
    vi.mocked(rpc).mockImplementation(
      (_procedure, _input, options) =>
        new Promise((resolve, reject) => {
          const capturedCursor = headCursor;
          const budget = options?.timeoutMs ?? 8_000;
          const cancel = () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
          };
          const timer = setTimeout(
            () => {
              options?.signal?.removeEventListener("abort", cancel);
              if (budget < 500) {
                reject(Object.assign(new Error("Request timed out"), { name: "TimeoutError" }));
              } else {
                resolve({ cursor: capturedCursor, threadId: "thread-1" });
              }
            },
            Math.min(500, budget),
          );
          options?.signal?.addEventListener("abort", cancel, { once: true });
        }) as never,
    );
    const snapRef = ref<MobileSnapshot | null>({
      botId: "bot-1",
      threadId: "thread-1",
      cursor: 10,
      olderCursor: null,
      messages: [],
      run: null,
      activeRuns: [],
    } as MobileSnapshot);
    const refresh = vi.fn(async () => snapRef.current ?? undefined);
    const refreshMentionBots = vi.fn(async () => {});
    const markReadIfVisible = vi.fn();
    const root = createRoot(document.createElement("div"));
    function Probe() {
      useThreadLiveSubscription({
        botId: "bot-1",
        focused: true,
        foreground: true,
        readOnly: false,
        sessionEpoch: 1,
        historyEpoch: ref(0),
        expandedHistoryThread: ref("thread-1"),
        pinnedAroundRef: ref(null),
        jumpScrollTarget: ref(null),
        jumpAnchor: ref({ release: vi.fn() } as unknown as ThreadJumpAnchor),
        snapRef,
        terminalRunIds: ref(new Set<string>()),
        readVisibleTarget: ref(null),
        showSavedThread: vi.fn(),
        refresh,
        commitSnap: (next) => {
          snapRef.current = next;
        },
        setError: vi.fn(),
        refreshMentionBots,
        markReadIfVisible,
      });
      return null;
    }
    const complete = (seq: number, runId: string): Event => ({ type: "run.completed", seq, runId });
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(subscribeThread).toHaveBeenCalledTimes(1);
      headCursor = 11;
      deliver(complete(11, "before-retry"));
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(rpc).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(250));
      deliver(complete(12, "during-retry"));
      expect(hapticSuccess).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(hapticSuccess).toHaveBeenCalledTimes(1);
      deliver(complete(12, "during-retry"));
      deliver(complete(13, "during-retry"));
      expect(hapticSuccess).toHaveBeenCalledTimes(1);
      deliver(complete(14, "after-retry"));
      expect(hapticSuccess).toHaveBeenCalledTimes(2);
      expect(subscribeThread).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(snapRef.current?.cursor).toBe(14);
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(["latest", "expanded", "search"])(
    "replays missed updates and clears in the %s window, but starts fresh for another chat",
    async (mode) => {
      const applied: number[] = [];
      const cursors: number[] = [];
      let deliver: (event: LiveEvent) => void = () => {};
      const snapshot = { cursor: 10 } as MobileSnapshot;
      vi.mocked(rpc).mockImplementation(async () => snapshot as never);
      vi.mocked(subscribeThread).mockImplementation(async (_target, cursor, onEvent, signal) => {
        cursors.push(cursor);
        deliver = onEvent as unknown as typeof deliver;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      });
      vi.mocked(reduceThreadSnapshot).mockImplementation((_snapshot, event) => {
        applied.push(event.seq ?? -1);
        return snapshot;
      });
      const refresh = vi.fn(async () => snapshot);
      const refreshMentionBots = vi.fn(async () => undefined);
      const markReadIfVisible = vi.fn();
      const refs = {
        historyEpoch: ref(0),
        expandedHistoryThread: ref<string | null>(mode === "latest" ? null : "thread-1"),
        pinnedAroundRef: ref<PinnedThreadWindow | null>(
          mode === "search"
            ? { messageId: "message-1", threadId: "thread-1", newerCursor: 5 }
            : null,
        ),
        jumpScrollTarget: ref<string | null>(mode === "search" ? "message-1" : null),
        jumpAnchor: ref({ release: vi.fn() } as unknown as ThreadJumpAnchor),
        snapRef: ref<MobileSnapshot | null>(snapshot),
        terminalRunIds: ref(new Set<string>()),
        readVisibleTarget: ref<string | null>(null),
      };
      function Probe({ botId, foreground }: { botId: string; foreground: boolean }) {
        useThreadLiveSubscription({
          botId,
          foreground,
          readOnly: false,
          sessionEpoch: 1,
          messageId: mode === "search" ? "message-1" : undefined,
          ...refs,
          showSavedThread: vi.fn(),
          refresh,
          commitSnap: vi.fn(),
          setError: vi.fn(),
          refreshMentionBots,
          markReadIfVisible,
        });
        return null;
      }
      const root = createRoot(document.createElement("div"));
      const render = (botId: string, foreground: boolean) =>
        act(async () => root.render(createElement(Probe, { botId, foreground })));

      await render("bot-1", true);
      deliver({ type: "thread.message.updated", seq: 11 });
      refresh.mockClear();
      // Another device paused a run; the event has no owner to expose Dismiss.
      deliver({ type: "run.waiting_input", seq: 12, runId: "run-other-device" });
      await act(async () => {});
      expect(applied).toEqual([11, 12]);
      expect(refresh).toHaveBeenCalledTimes(mode === "latest" ? 1 : 0);
      expect(refreshMentionBots).not.toHaveBeenCalled();
      await render("bot-1", false);
      // A late callback from the aborted stream must not advance the saved cursor.
      deliver({ type: "thread.message.updated", seq: 13 });
      snapshot.cursor = 20;
      await render("bot-1", true);
      expect(cursors).toEqual([10, 12]);
      deliver({ type: "thread.message.updated", seq: 13 });
      deliver({ type: "thread.cleared", seq: 14 });
      expect(applied).toEqual([11, 12, 13, 14]);
      expect(refs.expandedHistoryThread.current).toBeNull();
      expect(refs.pinnedAroundRef.current).toBeNull();
      expect(refs.jumpScrollTarget.current).toBeNull();
      await render("bot-2", true);
      expect(cursors).toEqual([10, 12, 20]);
      act(() => root.unmount());
    },
  );
});
