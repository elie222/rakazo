// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ThreadScrollState } from "@rakazo/core";
import { foldPeerReplies, openThreadWindow, withLiveStreamingProgress } from "@rakazo/core";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api";
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

type JumpTarget = { botId?: string; groupId?: string; messageId: string };

function mountJumpProbe(latest: MobileSnapshot, page: unknown, targetKey: "botId" | "groupId") {
  const rpc = vi.fn(async (method: string) =>
    method === "threads/get" ? structuredClone(latest) : page,
  );
  const probe = {
    jump: undefined as unknown as (target: JumpTarget) => Promise<void>,
    snapshot: null as MobileSnapshot | null,
    expandedPeerMarkers: new Set<string>() as ReadonlySet<string>,
    anchor: new ThreadJumpAnchor(),
  };

  function Probe() {
    const [snap, setSnap] = useState<MobileSnapshot | null>(latest);
    const [expandedPeerMarkers, setExpandedPeerMarkers] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const [, setThreadScrollState] = useState<ThreadScrollState>({
      detached: false,
      unread: false,
    });
    const pinnedAroundRef = useRef<{ messageId: string } | null>(null);
    const jumpScrollTarget = useRef<string | null>(null);
    const scope = {
      rpc,
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
      jumpAnchor: useRef(probe.anchor),
      jumpScrollTarget,
      newerLoadFailed: useRef(false),
      joinPinnedAfterLayout: useRef<number | null>(null),
      pinnedScrollMetrics: useRef({ offset: 0, viewport: 0, content: 0 }),
      snapRef: useRef<MobileSnapshot | null>(latest),
      streamResponsesRef: useRef(false),
      setSnap,
      setExpandedPeerMarkers,
      setThreadScrollState,
      scrollBehavior: useRef(new ThreadScrollBehavior()),
      foldPeerReplies,
      openThreadWindow,
      withLiveStreamingProgress,
      reconcileVisibleThreadSnapshot,
    };
    probe.jump = new Function(...Object.keys(scope), handlers)(...Object.values(scope));
    probe.snapshot = snap;
    probe.expandedPeerMarkers = expandedPeerMarkers;
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
  act(() => root.render(<Probe />));
  return {
    probe,
    container,
    unmount: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

describe("mobile search jump", () => {
  it.each(["botId", "groupId"] as const)(
    "publishes jumps within an unchanged, already-loaded %s thread",
    async (targetKey) => {
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
      const { probe, container, unmount } = mountJumpProbe(latest, page, targetKey);
      try {
        expect(container.querySelector('[data-list="live"]')).not.toBeNull();
        for (const seq of [1, 2]) {
          await act(() => probe.jump({ [targetKey]: "target-1", messageId: `message-${seq}` }));
          expect(probe.snapshot).toBe(latest);
          expect(container.querySelector('[data-list="pinned"]')?.getAttribute("data-target")).toBe(
            `message-${seq}`,
          );
          expect(probe.anchor.onMessageLayout(`message-${seq}`, 200, seq - 1, 24)).toBe(176);
        }
        expect(probe.expandedPeerMarkers.size).toBe(0);
      } finally {
        unmount();
      }
    },
  );

  it("expands the peer marker a jumped-to reply folds under", async () => {
    const latest: MobileSnapshot = {
      threadId: "thread-1",
      cursor: 3,
      olderCursor: null,
      run: null,
      messages: [
        {
          id: "received",
          seq: 1,
          role: "bot",
          runId: "run-peer",
          blocks: [
            {
              kind: "bot_message_received",
              fromBotId: "writer",
              fromBotName: "Writer",
              text: "Done.",
            },
          ],
        },
        {
          id: "reply",
          seq: 2,
          role: "bot",
          runId: "run-peer",
          blocks: [{ kind: "text", text: "Update from Writer: Done." }],
        },
        { id: "answer", seq: 3, role: "user", blocks: [{ kind: "text", text: "Thanks" }] },
      ],
    };
    const page = {
      threadId: latest.threadId,
      olderCursor: latest.olderCursor,
      messages: structuredClone(latest.messages),
    };
    const { probe, container, unmount } = mountJumpProbe(latest, page, "botId");
    try {
      await act(() => probe.jump({ botId: "target-1", messageId: "reply" }));
      expect(probe.expandedPeerMarkers).toEqual(new Set(["received"]));
      expect(container.querySelector('[data-list="pinned"]')?.getAttribute("data-target")).toBe(
        "reply",
      );
    } finally {
      unmount();
    }
  });
});
