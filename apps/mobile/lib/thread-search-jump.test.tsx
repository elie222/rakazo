// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ThreadScrollState } from "@rakazo/core";
import {
  latestDurableMessageSeq,
  mergeMessagesById,
  openThreadWindow,
  projectMessageReactions,
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
          t: (message: string) => message,
          projectMessageReactions,
          userVisibleMessages,
          hasVisibleMessagePresentation,
          freshReadSnapshot: useRef(false),
          visibleReadIds: useRef(new Set<string>()),
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
      expect(scope.snapRef.current.olderCursor).toBe(75);
      expect(
        unreadDividerMessageId(
          scope.snapRef.current.messages.filter((message) =>
            hasVisibleMessagePresentation(message.blocks),
          ),
          100,
          scope.snapRef.current.olderCursor,
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

function unreadJumpHarness(initial: MobileSnapshot, pages: MobileMessagePage[]) {
  let pageIndex = 0;
  const scope = {
    rpc: vi.fn(async (method: string, _input: unknown) =>
      method === "threads/get" ? initial : pages[pageIndex++]!,
    ),
    latestDurableMessageSeq,
    mergeMessagesById,
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
    pinnedRowLayouts: { current: new Map() },
    snapshotOrigin: { current: null },
    setShowingSaved: vi.fn(),
    historyEpoch: { current: 0 },
    jumpGeneration: { current: 0 },
    activeGroupId: { current: undefined },
    activeBotId: { current: "bot-1" },
    expandedHistoryThread: { current: null },
    pinnedAroundRef: { current: null as { messageId: string; coveredThroughSeq?: number } | null },
    jumpAnchor: { current: new ThreadJumpAnchor() },
    jumpScrollTarget: { current: null as string | null },
    newerLoadFailed: { current: false },
    joinPinnedAfterLayout: { current: null },
    pinnedScrollMetrics: { current: { offset: 0, viewport: 0, content: 0 } },
    snapRef: { current: initial },
    streamResponsesRef: { current: false },
    setSnap: vi.fn(),
    setThreadScrollState: vi.fn(),
    scrollBehavior: { current: new ThreadScrollBehavior() },
  };
  const jump = new Function(...Object.keys(scope), handlers)(...Object.values(scope)) as (target: {
    botId: string;
    seq: number;
  }) => Promise<boolean | undefined>;
  return { jump, scope };
}
