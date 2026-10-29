// @vitest-environment jsdom

import type { ThreadScrollState } from "@rakazo/core";
import { openThreadWindow, withLiveStreamingProgress } from "@rakazo/core";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api";
import { rpc } from "./api";
import { ThreadJumpAnchor } from "./thread-jump";
import { ThreadScrollBehavior } from "./thread-scroll";
import { reconcileVisibleThreadSnapshot } from "./thread-snapshot";
import type { PinnedThreadWindow } from "./thread-window";
import { applyThreadMessageJump } from "./thread-window";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./integrations-cache", () => ({ isIntegrationsScopeCurrent: () => true }));
vi.mock("./saved-chats", () => ({ liveSavedChatsScope: async () => ({}) }));

type JumpTarget = { botId?: string; groupId?: string; messageId: string };

function mountJumpProbe(latest: MobileSnapshot, page: unknown, targetKey: "botId" | "groupId") {
  vi.mocked(rpc).mockImplementation(
    async (method) => (method === "threads/get" ? structuredClone(latest) : page) as never,
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
    const pinnedAroundRef = useRef<PinnedThreadWindow | null>(null);
    const jumpScrollTarget = useRef<string | null>(null);
    const snapRef = useRef<MobileSnapshot | null>(latest);
    const jump = {
      pinnedAroundRef,
      jumpScrollTarget,
      jumpAnchor: useRef(probe.anchor),
      joinPinnedAfterLayout: useRef<number | null>(null),
      expandedHistoryThread: useRef<string | null>(null),
      scrollBehavior: useRef(new ThreadScrollBehavior()),
      snapRef,
      setThreadScrollState,
      // As the screen commits: an equal snapshot keeps the one already on screen.
      commitSnap: (next: MobileSnapshot | null) => {
        snapRef.current = next;
        const visible = withLiveStreamingProgress(next, false);
        setSnap((previous) => reconcileVisibleThreadSnapshot(previous, visible));
      },
      historyEpoch: useRef(0),
      jumpGeneration: useRef(0),
      activeBotId: useRef(targetKey === "botId" ? "target-1" : undefined),
      activeGroupId: useRef(targetKey === "groupId" ? "target-1" : undefined),
      newerLoadFailed: useRef(false),
      pinnedScrollMetrics: useRef({ offset: 0, viewport: 0, content: 0 }),
      snapshotOrigin: useRef(null),
      setExpandedPeerMarkers,
      setShowingSaved: vi.fn(),
    };
    probe.jump = (target) => applyThreadMessageJump(jump, target);
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
