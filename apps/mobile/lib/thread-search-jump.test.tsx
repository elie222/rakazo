// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ThreadScrollState } from "@rakazo/core";
import {
  latestDurableMessageSeq,
  mergeMessagesById,
  mergeThreadHistory,
  openThreadWindow,
  projectMessageReactions,
  threadHistoryWasCleared,
  unreadDividerMessageId,
  userVisibleMessages,
  withLiveStreamingProgress,
} from "@rakazo/core";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileMessagePage, MobileSnapshot } from "./api";
import { hasVisibleMessagePresentation } from "./message-presentation";
import { ThreadJumpAnchor } from "./thread-jump";
import { mobileVisibleReadSeq } from "./thread-read";
import { ThreadScrollBehavior } from "./thread-scroll";
import { reconcileVisibleThreadSnapshot } from "./thread-snapshot";

// Exercise the screen's handlers without importing its native dependencies.
const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
const commitStart = source.indexOf("  function commitSnap(");
const commitHandler = source.slice(commitStart, source.indexOf("  useEffect(() => {", commitStart));
const jumpHandler = source.slice(
  source.indexOf("  async function applyMessageJump("),
  source.indexOf("  async function loadNewerMessages("),
);
const handlers = ts.transpileModule(`${commitHandler}\n${jumpHandler}\nreturn applyMessageJump;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const readHandler = source.slice(
  source.indexOf("  const markReadIfVisible = useCallback("),
  source.indexOf("  const onViewableItemsChanged = useRef("),
);
const unreadEffectStart = source.indexOf(
  "    const visit = readVisit.current;",
  source.indexOf(readHandler),
);
const unreadEffect = source.slice(
  unreadEffectStart,
  source.indexOf(
    "  }, [snap, showingSaved, readVisitVersion, markReadIfVisible]);",
    unreadEffectStart,
  ),
);

describe("mobile search jump", () => {
  it.each([
    ["botId", "messageId"],
    ["groupId", "messageId"],
    ["botId", "seq"],
    ["groupId", "seq"],
  ] as const)(
    "publishes jumps within an unchanged, already-loaded %s thread by %s",
    async (targetKey, position) => {
      const latest: MobileSnapshot = {
        threadId: "thread-1",
        cursor: 2,
        olderCursor: null,
        run: null,
        messages: [1, 2].map((seq) => ({
          id: `message-${seq}`,
          seq,
          role: "user",
          blocks: [{ kind: "text", text: `Message ${seq}` }],
        })),
      };
      const page = {
        threadId: latest.threadId,
        olderCursor: latest.olderCursor,
        messages: structuredClone(latest.messages),
      };
      const opened = openThreadWindow(latest, page);
      expect(opened.newerCursor).toBeNull();
      expect(reconcileVisibleThreadSnapshot(latest, opened.snapshot)).toBe(latest);
      const rpc = vi.fn(async (method: string) =>
        method === "threads/get" ? structuredClone(latest) : page,
      );
      let jump!: (target: {
        botId?: string;
        groupId?: string;
        messageId?: string;
        seq?: number;
      }) => Promise<void>;
      let renderedSnapshot: MobileSnapshot | null = null;
      const anchor = new ThreadJumpAnchor();

      function Probe() {
        const [snap, setSnap] = useState<MobileSnapshot | null>(latest);
        const [, setThreadScrollState] = useState<ThreadScrollState>({
          detached: false,
          unread: false,
        });
        const pinnedAroundRef = useRef<{ messageId: string } | null>(null);
        const jumpScrollTarget = useRef<string | null>(null);
        const scope = {
          rpc,
          latestDurableMessageSeq,
          mergeMessagesById,
          threadHistoryWasCleared,
          t: (message: string) => message,
          projectMessageReactions,
          userVisibleMessages,
          hasVisibleMessagePresentation,
          freshReadSnapshot: useRef(false),
          visibleReadIds: useRef(new Set<string>()),
          visibleReadCallIds: useRef(new Set<string>()),
          pinnedRowLayouts: useRef(new Map()),
          liveSavedChatsScope: async () => ({}),
          isIntegrationsScopeCurrent: () => true,
          snapshotOrigin: useRef(null),
          setShowingSaved: vi.fn(),
          historyEpoch: useRef(0),
          jumpGeneration: useRef(0),
          activeGroupId: useRef(targetKey === "groupId" ? "target-1" : undefined),
          activeBotId: useRef(targetKey === "botId" ? "target-1" : undefined),
          expandedHistoryThread: useRef<string | null>(null),
          pinnedAroundRef,
          jumpAnchor: useRef(anchor),
          jumpScrollTarget,
          newerLoadFailed: useRef(false),
          joinPinnedAfterLayout: useRef<number | null>(null),
          pinnedScrollMetrics: useRef({ offset: 0, viewport: 0, content: 0 }),
          snapRef: useRef<MobileSnapshot | null>(latest),
          streamResponsesRef: useRef(false),
          setSnap,
          setThreadScrollState,
          scrollBehavior: useRef(new ThreadScrollBehavior()),
          openThreadWindow,
          withLiveStreamingProgress,
          reconcileVisibleThreadSnapshot,
        };
        jump = new Function(...Object.keys(scope), handlers)(...Object.values(scope));
        renderedSnapshot = snap;
        return (
          <div
            data-list={pinnedAroundRef.current ? "pinned" : "live"}
            data-target={jumpScrollTarget.current}
          />
        );
      }

      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        act(() => root.render(<Probe />));
        expect(container.querySelector('[data-list="live"]')).not.toBeNull();
        for (const seq of [1, 2]) {
          await act(() =>
            jump({
              [targetKey]: "target-1",
              ...(position === "messageId" ? { messageId: `message-${seq}` } : { seq }),
            }),
          );
          expect(renderedSnapshot).toBe(latest);
          expect(container.querySelector('[data-list="pinned"]')?.getAttribute("data-target")).toBe(
            `message-${seq}`,
          );
          expect(anchor.onMessageLayout(`message-${seq}`, 200, seq - 1, 24)).toBe(176);
        }
      } finally {
        act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["empty", "filtered"])(
    "scans past %s around-pages to the first rendered unread message",
    async (kind) => {
      const initial: MobileSnapshot = {
        threadId: "thread-1",
        cursor: 500,
        olderCursor: 300,
        run: null,
        readState: { lastReadSeq: 100, lastUnreadSeq: 300, unread: true },
        messages: [
          { id: "tail", seq: 300, role: "bot", blocks: [{ kind: "text", text: "Newest" }] },
        ],
      };
      const pages: MobileMessagePage[] = [
        {
          threadId: "thread-1",
          olderCursor: 75,
          coveredThroughSeq: 150,
          messages: kind === "empty" ? [] : [{ id: "hidden", seq: 130, role: "bot", blocks: [] }],
        },
        { threadId: "thread-1", olderCursor: 125, coveredThroughSeq: 175, messages: [] },
        {
          threadId: "thread-1",
          olderCursor: 150,
          coveredThroughSeq: 200,
          messages: [
            {
              id: "first-unread",
              seq: 180,
              role: "bot",
              blocks: [{ kind: "text", text: "First unread reply" }],
            },
          ],
        },
      ];
      const { jump, scope } = unreadJumpHarness(initial, pages);
      await jump({ botId: "bot-1", seq: 101 });
      expect(
        scope.rpc.mock.calls
          .filter(([method]) => method === "threads/messages")
          .map(([, input]) => input),
      ).toEqual([
        { botId: "bot-1", around: { seq: 101 } },
        { botId: "bot-1", around: { seq: 151 } },
        { botId: "bot-1", around: { seq: 176 } },
      ]);
      expect(scope.pinnedAroundRef.current).toMatchObject({
        messageId: "first-unread",
        coveredThroughSeq: 200,
      });
      expect(scope.snapRef.current!.olderCursor).toBe(75);
      expect(
        unreadDividerMessageId(
          scope.snapRef.current!.messages.filter((message) =>
            hasVisibleMessagePresentation(message.blocks),
          ),
          100,
          scope.snapRef.current!.olderCursor,
        ),
      ).toBe("first-unread");
      expect(scope.jumpScrollTarget.current).toBe("first-unread");
    },
  );

  it.each(["stalls", "exhausts history"])(
    "does not fall back to the latest page when unread scanning %s",
    async (scenario) => {
      const initial: MobileSnapshot = {
        threadId: "thread-1",
        cursor: 500,
        olderCursor: 300,
        run: null,
        readState: { lastReadSeq: 100, lastUnreadSeq: 300, unread: true },
        messages: [
          { id: "tail", seq: 300, role: "bot", blocks: [{ kind: "text", text: "Newest" }] },
        ],
      };
      const empty: MobileMessagePage = {
        threadId: "thread-1",
        olderCursor: 75,
        coveredThroughSeq: 150,
        messages: [],
      };
      const { jump, scope } = unreadJumpHarness(initial, [
        empty,
        { ...empty, coveredThroughSeq: scenario === "stalls" ? 150 : 350 },
      ]);
      await expect(jump({ botId: "bot-1", seq: 101 })).rejects.toThrow(
        "Could not load earlier messages",
      );
      expect(scope.snapRef.current).toBe(initial);
      expect(scope.setSnap).not.toHaveBeenCalled();
      expect(scope.pinnedAroundRef.current).toBeNull();
      expect(scope.freshReadSnapshot.current).toBe(false);
    },
  );

  it("finishes a fully covered hidden-only unread scan and acknowledges a later visible reply", async () => {
    const initial: MobileSnapshot = {
      threadId: "thread-1",
      cursor: 500,
      olderCursor: null,
      run: null,
      readState: { lastReadSeq: 100, lastUnreadSeq: 180, unread: true },
      messages: [
        { id: "read", seq: 100, role: "bot", blocks: [{ kind: "text", text: "Earlier reply" }] },
        {
          id: "hidden",
          seq: 180,
          role: "bot",
          blocks: [{ kind: "steps", steps: [{ label: "Browser", count: 1 }] }],
        },
      ],
    };
    const { scope, beginUnreadVisit, markRead } = unreadJumpHarness(initial, [
      { threadId: "thread-1", olderCursor: 75, coveredThroughSeq: 150, messages: [] },
      {
        threadId: "thread-1",
        olderCursor: 125,
        coveredThroughSeq: 180,
        messages: [initial.messages[1]!],
      },
    ]);
    scope.freshReadSnapshot.current = true;
    scope.readVisit.current = { threadId: initial.threadId, boundary: 100, opened: false };
    beginUnreadVisit();
    expect(scope.openingUnread.current).toBe(true);
    await vi.waitFor(() => expect(scope.openingUnread.current).toBe(false));
    expect(scope.jumpScrollTarget.current).toBeNull();
    expect(scope.setUnreadOpeningFailed).not.toHaveBeenCalledWith(true);
    scope.visibleReadIds.current = new Set(["read"]);
    markRead();
    expect(scope.rpc.mock.calls.filter(([method]) => method === "threads/markRead")).toEqual([]);

    scope.snapRef.current = {
      ...initial,
      cursor: 501,
      readState: { lastReadSeq: 100, lastUnreadSeq: 181, unread: true },
      messages: [
        ...initial.messages,
        { id: "reply", seq: 181, role: "bot", blocks: [{ kind: "text", text: "New reply" }] },
      ],
    };
    // A new reply outside the viewport must still remain unread.
    markRead();
    expect(scope.rpc.mock.calls.filter(([method]) => method === "threads/markRead")).toEqual([]);
    scope.visibleReadIds.current = new Set(["reply"]);
    markRead();
    expect(scope.rpc).toHaveBeenLastCalledWith("threads/markRead", {
      botId: "bot-1",
      throughSeq: 181,
    });
  });

  it("offers explicit recovery after the current unread request fails without acknowledging the tail", async () => {
    const initial: MobileSnapshot = {
      threadId: "thread-1",
      cursor: 500,
      olderCursor: 300,
      run: null,
      readState: { lastReadSeq: 100, lastUnreadSeq: 300, unread: true },
      messages: [{ id: "tail", seq: 300, role: "bot", blocks: [{ kind: "text", text: "Newest" }] }],
    };
    const { scope, beginUnreadVisit, markRead, jumpToLatest } = unreadJumpHarness(initial, []);
    const originalRpc = scope.rpc.getMockImplementation()!;
    scope.rpc.mockImplementation(async (method, input) => {
      if (method === "threads/messages") throw new Error("offline");
      return originalRpc(method, input);
    });
    scope.freshReadSnapshot.current = true;
    scope.readVisit.current = { threadId: initial.threadId, boundary: 100, opened: false };
    beginUnreadVisit();
    await vi.waitFor(() => expect(scope.setUnreadOpeningFailed).toHaveBeenLastCalledWith(true));
    scope.visibleReadIds.current = new Set(["tail"]);
    markRead();
    expect(scope.openingUnread.current).toBe(true);
    expect(scope.rpc.mock.calls.filter(([method]) => method === "threads/markRead")).toEqual([]);
    jumpToLatest();
    expect(scope.setUnreadOpeningFailed).toHaveBeenLastCalledWith(false);
    expect(scope.openingUnread.current).toBe(false);
    expect(scope.performScroll).toHaveBeenCalled();
    expect(scope.rpc).toHaveBeenLastCalledWith("threads/markRead", {
      botId: "bot-1",
      throughSeq: 300,
    });
  });

  it("drops an unread scan overtaken by a conversation clear", async () => {
    const initial: MobileSnapshot = {
      threadId: "thread-1",
      cursor: 500,
      olderCursor: 300,
      run: null,
      messages: [{ id: "tail", seq: 300, role: "bot", blocks: [{ kind: "text", text: "Newest" }] }],
    };
    const empty: MobileMessagePage = {
      threadId: "thread-1",
      olderCursor: 75,
      coveredThroughSeq: 150,
      messages: [],
    };
    const { jump, scope } = unreadJumpHarness(initial, [
      empty,
      { ...empty, coveredThroughSeq: 175 },
    ]);
    const originalRpc = scope.rpc.getMockImplementation()!;
    scope.rpc.mockImplementation(async (method, input) => {
      const result = await originalRpc(method, input);
      if (
        method === "threads/messages" &&
        (input as { around: { seq: number } }).around.seq === 151
      ) {
        scope.historyEpoch.current += 1;
      }
      return result;
    });
    expect(await jump({ botId: "bot-1", seq: 101 })).toBeUndefined();
    expect(scope.setSnap).not.toHaveBeenCalled();
    expect(scope.pinnedAroundRef.current).toBeNull();
  });
});

describe("mobile cleared history reconciliation", () => {
  it("releases pinned history and read tracking when a reconnect snapshot advances generation without a clear event", () => {
    const { initial, fresh } = clearedSnapshots();
    const { scope, commit } = unreadJumpHarness(initial, []);
    scope.expandedHistoryThread.current = initial.threadId;
    scope.pinnedAroundRef.current = { messageId: "old" };
    scope.jumpScrollTarget.current = "old";
    scope.jumpAnchor.current.begin("old");
    scope.readVisit.current = { threadId: initial.threadId, boundary: 0, opened: true };
    scope.visibleReadIds.current.add("old");
    scope.visibleReadCallIds.current.add("old");
    scope.readRequest.current = { threadId: initial.threadId, throughSeq: 1 };
    scope.loadingOlderContent.current = true;
    scope.loadingNewerContent.current = true;
    scope.openingUnread.current = true;

    commit(mergeThreadHistory(initial, fresh, true));

    expect(scope.snapRef.current).toBe(fresh);
    expect(scope.snapRef.current?.messages.map((message) => message.id)).toEqual(["new"]);
    expect(scope.historyEpoch.current).toBe(1);
    expect(scope.expandedHistoryThread.current).toBeNull();
    expect(scope.pinnedAroundRef.current).toBeNull();
    expect(scope.jumpScrollTarget.current).toBeNull();
    expect(scope.jumpAnchor.current.holds()).toBe(false);
    expect(scope.readVisit.current).toBeNull();
    expect(scope.readRequest.current).toBeNull();
    expect(scope.visibleReadIds.current.size).toBe(0);
    expect(scope.visibleReadCallIds.current.size).toBe(0);
    expect(scope.openingUnread.current).toBe(false);
    expect(scope.setLoadingOlder).toHaveBeenCalledWith(false);
    expect(scope.setLoadingNewer).toHaveBeenCalledWith(false);

    commit({ ...fresh, cursor: 103 });
    expect(scope.historyEpoch.current).toBe(1);
  });

  it.each(["initial", "pinned"])(
    "opens a valid explicit search in a cleared conversation from an %s snapshot",
    async (position) => {
      const { initial, fresh } = clearedSnapshots();
      const { jump, scope } = unreadJumpHarness(initial, []);
      scope.snapRef.current = position === "initial" ? null : initial;
      scope.rpc.mockImplementation(async (method) => {
        if (method === "threads/get") return fresh;
        expect(scope.snapRef.current?.historyGeneration).toBe(1);
        expect(scope.jumpAnchor.current.holds()).toBe(true);
        return { threadId: fresh.threadId, messages: fresh.messages, olderCursor: null };
      });
      expect(await jump({ botId: "bot-1", messageId: "new" })).toBe(true);
      expect(scope.rpc.mock.calls.map(([method]) => method)).toEqual([
        "threads/get",
        "threads/messages",
      ]);
      expect(scope.pinnedAroundRef.current?.messageId).toBe("new");
      expect(scope.snapRef.current?.messages.map((message) => message.id)).toEqual(["new"]);
      expect(scope.snapRef.current?.historyGeneration).toBe(1);
    },
  );

  it("restarts automatic unread positioning from the fresh generation before fetching a page", async () => {
    const { initial, fresh } = clearedSnapshots();
    const { jump, scope } = unreadJumpHarness(initial, []);
    scope.rpc.mockResolvedValue(fresh);
    expect(await jump({ botId: "bot-1", seq: 1 })).toBeUndefined();
    expect(scope.rpc.mock.calls.map(([method]) => method)).toEqual(["threads/get"]);
    expect(scope.snapRef.current).toBe(fresh);
    expect(scope.historyEpoch.current).toBe(1);
    expect(scope.pinnedAroundRef.current).toBeNull();
  });
});

function clearedSnapshots(): { initial: MobileSnapshot; fresh: MobileSnapshot } {
  const initial: MobileSnapshot = {
    threadId: "thread-1",
    historyGeneration: 0,
    cursor: 100,
    olderCursor: 1,
    run: null,
    readState: { lastReadSeq: 0, lastUnreadSeq: 1, unread: true },
    messages: [{ id: "old", seq: 1, role: "bot", blocks: [{ kind: "text", text: "Deleted" }] }],
  };
  const fresh: MobileSnapshot = {
    ...initial,
    historyGeneration: 1,
    cursor: 102,
    olderCursor: null,
    readState: { lastReadSeq: 6, lastUnreadSeq: 7, unread: true },
    messages: [{ id: "new", seq: 7, role: "bot", blocks: [{ kind: "text", text: "After clear" }] }],
  };
  return { initial, fresh };
}

function unreadJumpHarness(initial: MobileSnapshot, pages: MobileMessagePage[]) {
  let pageIndex = 0;
  const scope = {
    rpc: vi.fn(async (method: string, _input: unknown) =>
      method === "threads/get"
        ? initial
        : method === "threads/markRead"
          ? { ok: true }
          : pages[pageIndex++]!,
    ),
    latestDurableMessageSeq,
    mergeMessagesById,
    threadHistoryWasCleared,
    projectMessageReactions,
    userVisibleMessages,
    hasVisibleMessagePresentation,
    openThreadWindow,
    withLiveStreamingProgress,
    reconcileVisibleThreadSnapshot,
    t: (message: string) => message,
    liveSavedChatsScope: async () => ({}),
    isIntegrationsScopeCurrent: () => true,
    freshReadSnapshot: { current: false },
    visibleReadIds: { current: new Set<string>() },
    visibleReadCallIds: { current: new Set<string>() },
    pinnedRowLayouts: { current: new Map() },
    snapshotOrigin: { current: null },
    setShowingSaved: vi.fn(),
    historyEpoch: { current: 0 },
    jumpGeneration: { current: 0 },
    activeGroupId: { current: undefined },
    activeBotId: { current: "bot-1" },
    expandedHistoryThread: { current: null as string | null },
    loadingOlderContent: { current: false },
    loadingNewerContent: { current: false },
    setLoadingOlder: vi.fn(),
    setLoadingNewer: vi.fn(),
    readVisit: {
      current: null as { threadId: string; boundary: number | null; opened: boolean } | null,
    },
    readRequest: { current: null as { threadId: string; throughSeq: number } | null },
    openingUnread: { current: false },
    setUnreadOpeningFailed: vi.fn(),
    botId: "bot-1",
    groupId: undefined,
    messageId: undefined,
    readOnly: false,
    showingSaved: false,
    headerHeight: 0,
    readViewportReady: { current: true },
    AppState: { currentState: "active" },
    navigation: { isFocused: () => true },
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    mobileVisibleReadSeq,
    dismissThreadNotifications: vi.fn(async () => undefined),
    errorText: (error: Error) => error.message,
    setError: vi.fn(),
    performScroll: vi.fn(),
    publishThreadScrollState: vi.fn(),
    pinnedAroundRef: { current: null as { messageId: string; coveredThroughSeq?: number } | null },
    jumpAnchor: { current: new ThreadJumpAnchor() },
    jumpScrollTarget: { current: null as string | null },
    newerLoadFailed: { current: false },
    joinPinnedAfterLayout: { current: null },
    pinnedScrollMetrics: { current: { offset: 0, viewport: 0, content: 0 } },
    snapRef: { current: initial as MobileSnapshot | null },
    streamResponsesRef: { current: false },
    setSnap: vi.fn(),
    setThreadScrollState: vi.fn(),
    scrollBehavior: { current: new ThreadScrollBehavior() },
  };
  const jump = new Function(...Object.keys(scope), handlers)(...Object.values(scope)) as (target: {
    botId: string;
    seq?: number;
    messageId?: string;
  }) => Promise<boolean | undefined>;
  const commit = new Function(
    ...Object.keys(scope),
    ts.transpileModule(`${commitHandler}\nreturn commitSnap;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(...Object.values(scope)) as (next: MobileSnapshot | null, cleared?: boolean) => void;
  const readScope = { ...scope, commitSnap: commit };
  const { markReadIfVisible, markVisibleRef } = new Function(
    ...Object.keys(readScope),
    ts.transpileModule(`${readHandler}\nreturn {markReadIfVisible, markVisibleRef};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(...Object.values(readScope));
  const visitScope = { ...scope, applyMessageJump: jump, markReadIfVisible, markVisibleRef };
  const beginUnreadVisit = new Function(
    ...Object.keys(visitScope),
    ts.transpileModule(`return function () {${unreadEffect}};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(...Object.values(visitScope));
  const latestHandler = source.slice(
    source.indexOf("  function jumpToLatest() {"),
    source.indexOf("  async function loadOlderMessages() {"),
  );
  const jumpToLatest = new Function(
    ...Object.keys(visitScope),
    `${latestHandler}\nreturn jumpToLatest;`,
  )(...Object.values(visitScope));
  return { jump, scope, commit, beginUnreadVisit, markRead: markReadIfVisible, jumpToLatest };
}
