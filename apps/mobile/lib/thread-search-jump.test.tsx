// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ThreadScrollState } from "@rakazo/core";
import { openThreadWindow, withLiveStreamingProgress } from "@rakazo/core";
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
      const rpc = vi.fn(async (method: string) =>
        method === "threads/get" ? structuredClone(latest) : page,
      );
      let jump!: (target: { botId?: string; groupId?: string; messageId: string }) => Promise<void>;
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
          await act(() => jump({ [targetKey]: "target-1", messageId: `message-${seq}` }));
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
});
