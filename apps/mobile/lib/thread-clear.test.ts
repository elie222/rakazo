import { readFileSync } from "node:fs";
import {
  appendNewerThreadPage,
  forwardProbeAfterPage,
  prependThreadHistoryPage,
  threadHistoryWasCleared,
  threadWindowMessages,
  withLiveStreamingProgress,
} from "@rakazo/core";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileMessagePage, MobileSnapshot } from "./api";
import { ThreadJumpAnchor } from "./thread-jump";
import { ThreadScrollBehavior } from "./thread-scroll";
import { reconcileVisibleThreadSnapshot } from "./thread-snapshot";

// Run the actual screen handlers without loading native modules.
const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const commitStart = source.indexOf("  function commitSnap(");
const handlerSource = [
  source.slice(commitStart, source.indexOf("  useEffect(() => {", commitStart)),
  source.slice(
    source.indexOf("  function clearConversation()"),
    source.indexOf("  const botActions ="),
  ),
  source.slice(
    source.indexOf("  async function loadNewerMessages()"),
    source.indexOf("  function showLatest()"),
  ),
  source.slice(
    source.indexOf("  async function loadOlderMessages()"),
    source.indexOf("  const markReadIfVisible ="),
  ),
].join("\n");
const handlerCode = ts.transpileModule(
  `${handlerSource}\nreturn {commitSnap, clearConversation, loadOlderMessages, loadNewerMessages, invalidateHistoryLoads};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function snapshot(seqs: number[], historyGeneration = 0): MobileSnapshot {
  return {
    threadId: "thread-1",
    historyGeneration,
    cursor: seqs.at(-1) ?? 0,
    olderCursor: seqs[0] ?? null,
    run: null,
    readState: { lastReadSeq: 0, lastUnreadSeq: seqs.at(-1) ?? 0, unread: true },
    messages: seqs.map((seq) => ({
      id: `message-${seq}`,
      seq,
      role: "bot",
      blocks: [{ kind: "text", text: `Reply ${seq}` }],
    })),
  };
}

function setup() {
  const requests: Array<{ method: string; resolve: (value: unknown) => void }> = [];
  const scope = {
    botId: "bot-1",
    groupId: undefined,
    activeBotId: "bot-1",
    sessionGeneration: 1,
    spaceId: "space-1",
    currentSessionGeneration: () => scope.sessionGeneration,
    selectedSpaceId: () => scope.spaceId,
    isCurrentTarget: (botId: string) => botId === scope.activeBotId,
    snapRef: { current: snapshot([1, 2, 10]) },
    historyEpoch: { current: 0 },
    expandedHistoryThread: { current: "thread-1" as string | null },
    pinnedAroundRef: {
      current: { threadId: "thread-1", newerCursor: 2 } as {
        threadId: string;
        newerCursor: number | null;
      } | null,
    },
    jumpScrollTarget: { current: "message-1" as string | null },
    jumpAnchor: { current: new ThreadJumpAnchor() },
    joinPinnedAfterLayout: { current: null },
    loadingOlderContent: { current: false },
    loadingNewerContent: { current: false },
    newerLoadFailed: { current: false },
    loadingOlder: false,
    loadingNewer: false,
    setLoadingOlder: vi.fn((value: boolean) => {
      scope.loadingOlder = value;
    }),
    setLoadingNewer: vi.fn((value: boolean) => {
      scope.loadingNewer = value;
    }),
    readVisit: { current: { threadId: "thread-1", boundary: 0, opened: true } as unknown },
    visibleReadIds: { current: new Set(["message-2"]) },
    visibleReadCallIds: { current: new Set<string>() },
    pinnedRowLayouts: { current: new Map() },
    readRequest: { current: null },
    openingUnread: { current: true },
    setUnreadOpeningFailed: vi.fn(),
    scrollBehavior: { current: new ThreadScrollBehavior() },
    setThreadScrollState: vi.fn(),
    streamResponsesRef: { current: false },
    setSnap: vi.fn(),
    pinnedScrollMetrics: { current: { content: 100 } },
    rpc: vi.fn(
      (method: string, _input: unknown) =>
        new Promise((resolve) => requests.push({ method, resolve })),
    ),
    refresh: vi.fn(async () => undefined),
    Alert: { alert: vi.fn() },
    t: (value: string) => value,
    errorText: (error: Error) => error.message,
    setError: vi.fn(),
    loadNewerNearEnd: vi.fn(),
    appendNewerThreadPage,
    forwardProbeAfterPage,
    prependMobileMessagePage: prependThreadHistoryPage,
    threadHistoryWasCleared,
    threadWindowMessages,
    withLiveStreamingProgress,
    reconcileVisibleThreadSnapshot,
  };
  const handlers = () => {
    const render = { ...scope, snap: scope.snapRef.current };
    return new Function(...Object.keys(render), handlerCode)(...Object.values(render)) as {
      commitSnap: (next: MobileSnapshot, cleared?: boolean) => void;
      clearConversation: () => void;
      loadOlderMessages: () => Promise<void>;
      loadNewerMessages: () => Promise<void>;
      invalidateHistoryLoads: () => void;
    };
  };
  return { scope, requests, handlers };
}

describe("mobile local conversation clear", () => {
  it("resets pending history loads without SSE and lets new loads finish while stale responses settle", async () => {
    const { scope, requests, handlers } = setup();
    const before = handlers();
    const staleOlder = before.loadOlderMessages();
    const staleNewer = before.loadNewerMessages();
    expect(scope.loadingOlder).toBe(true);
    expect(scope.loadingNewer).toBe(true);
    before.clearConversation();
    expect(requests[2]!.method).toBe("threads/clear");
    requests[2]!.resolve({ ok: true });
    await vi.waitFor(() => expect(scope.refresh).toHaveBeenCalledOnce());

    expect(scope.historyEpoch.current).toBe(1);
    expect(scope.loadingOlder).toBe(false);
    expect(scope.loadingNewer).toBe(false);
    expect(scope.loadingOlderContent.current).toBe(false);
    expect(scope.loadingNewerContent.current).toBe(false);
    expect(scope.snapRef.current.messages).toEqual([]);
    expect(scope.snapRef.current.readState).toBeUndefined();
    expect(scope.pinnedAroundRef.current).toBeNull();
    expect(scope.readVisit.current).toBeNull();

    // A later loaded window can page immediately, even while pre-clear requests remain pending.
    before.commitSnap(snapshot([21, 22, 30]));
    scope.pinnedAroundRef.current = { threadId: "thread-1", newerCursor: 22 };
    const after = handlers();
    const newOlder = after.loadOlderMessages();
    const newNewer = after.loadNewerMessages();
    expect(requests).toHaveLength(5);
    const stalePage: MobileMessagePage = { ...snapshot([0, 1, 2, 3]), coveredThroughSeq: 3 };
    requests[0]!.resolve(stalePage);
    requests[1]!.resolve(stalePage);
    await Promise.all([staleOlder, staleNewer]);
    expect(scope.loadingOlder).toBe(true);
    expect(scope.loadingNewer).toBe(true);
    expect(scope.snapRef.current.messages.map((message) => message.seq)).toEqual([21, 22, 30]);

    requests[3]!.resolve({ ...snapshot([20]), olderCursor: null });
    await newOlder;
    requests[4]!.resolve({ ...snapshot([23]), coveredThroughSeq: 23 });
    await newNewer;
    expect(scope.loadingOlder).toBe(false);
    expect(scope.loadingNewer).toBe(false);
    expect(scope.snapRef.current.messages.map((message) => message.seq)).toEqual([
      20, 21, 22, 23, 30,
    ]);
    expect(scope.Alert.alert).not.toHaveBeenCalled();
  });

  it("preserves replies from a newer clear generation received before the clear response", async () => {
    const { scope, requests, handlers } = setup();
    const screen = handlers();
    screen.clearConversation();
    const fresh = snapshot([21], 1);
    screen.commitSnap(fresh);
    requests[0]!.resolve({ ok: true });
    await vi.waitFor(() => expect(scope.refresh).toHaveBeenCalledOnce());
    expect(scope.snapRef.current).toBe(fresh);
    expect(scope.historyEpoch.current).toBe(1);
  });

  it.each(["thread", "session", "space"])(
    "ignores a clear response after the %s changes",
    async (change) => {
      const { scope, requests, handlers } = setup();
      handlers().clearConversation();
      if (change === "thread") scope.activeBotId = "bot-2";
      if (change === "session") scope.sessionGeneration += 1;
      if (change === "space") scope.spaceId = "space-2";
      const other = { ...snapshot([21]), threadId: change === "thread" ? "thread-2" : "thread-1" };
      scope.snapRef.current = other;
      requests[0]!.resolve({ ok: true });
      await Promise.resolve();
      expect(scope.snapRef.current).toBe(other);
      expect(scope.refresh).not.toHaveBeenCalled();
      expect(scope.historyEpoch.current).toBe(0);
    },
  );

  it("resets pagination when the subscription invalidates pending loads", async () => {
    const { scope, requests, handlers } = setup();
    const screen = handlers();
    const older = screen.loadOlderMessages();
    const newer = screen.loadNewerMessages();
    screen.invalidateHistoryLoads();
    expect(scope.loadingOlder).toBe(false);
    expect(scope.loadingNewer).toBe(false);
    expect(scope.loadingOlderContent.current).toBe(false);
    expect(scope.loadingNewerContent.current).toBe(false);
    expect(scope.snapRef.current.messages).toHaveLength(3);
    requests[0]!.resolve(snapshot([0]));
    requests[1]!.resolve(snapshot([3]));
    await Promise.all([older, newer]);
    expect(scope.loadingOlder).toBe(false);
    expect(scope.loadingNewer).toBe(false);
  });
});
