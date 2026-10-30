// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiModule from "./api";
import type { MobileSnapshot } from "./api";
import { applyMobileThreadEvent, rpc, subscribeThread } from "./api";
import type { ThreadJumpAnchor } from "./thread-jump";
import { useThreadLiveSubscription } from "./thread-live";
import type { PinnedThreadWindow } from "./thread-window";

vi.mock("./api", () => ({
  rpc: vi.fn(),
  subscribeThread: vi.fn(),
  applyMobileThreadEvent: vi.fn(),
}));
const session = vi.hoisted(() => ({ generation: 1 }));
vi.mock("./session", () => ({ currentSessionGeneration: () => session.generation }));
vi.mock("./user-error", () => ({ errorText: String }));
// The member status test runs the real reducer; keep its native imports out of jsdom.
vi.mock("./ai-consent", () => ({}));
vi.mock("./live-notifications", () => ({}));
vi.mock("expo-secure-store", () => ({}));

type LiveEvent = { type: string; seq: number; runId?: string };
const ref = <T>(current: T) => ({ current });

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  session.generation = 1;
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
    vi.mocked(applyMobileThreadEvent).mockReturnValue(snapshot);
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
    const actual = await vi.importActual<typeof ApiModule>("./api");
    vi.mocked(applyMobileThreadEvent).mockImplementation(actual.applyMobileThreadEvent);
    let deliver: (event: LiveEvent & { botId?: string }) => void = () => {};
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
        readOnly: false,
        sessionEpoch: 1,
        historyEpoch: ref(0),
        expandedHistoryThread: ref<string | null>("thread-1"),
        pinnedAroundRef: ref(null),
        jumpScrollTarget: ref(null),
        jumpAnchor: ref({ release: vi.fn() } as unknown as ThreadJumpAnchor),
        snapRef,
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
    deliver({ type: "run.completed", seq: 14, botId: "bot-1", runId: "run-1" });
    await act(async () => {});
    expect(status()).toBe("idle");
    expect(refresh).not.toHaveBeenCalled();
    act(() => root.unmount());
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
      vi.mocked(applyMobileThreadEvent).mockImplementation((_snapshot, event) => {
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
