// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ThreadScrollState } from "@rakazo/core";
import {
  appendNewerThreadPage,
  leaveThreadWindow,
  openThreadWindow,
  reconcileThreadScrollState,
} from "@rakazo/core";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ThreadJumpAnchor } from "./thread-jump";
import { ThreadScrollBehavior } from "./thread-scroll";

// Exercise the screen's actual handler without importing its native dependencies.
const source = readFileSync(resolve("apps/mobile/app/thread.tsx"), "utf8");
const handler = source.slice(
  source.indexOf("  function showLatest() {"),
  source.indexOf("  async function loadOlderMessages() {"),
);

function page(seqs: number[]) {
  return {
    threadId: "thread-1",
    olderCursor: 1,
    messages: seqs.map((seq) => ({ id: `message-${seq}`, seq })),
  };
}

describe("mobile jump to latest", () => {
  it.each(["no newer gap", "newer pages closed the gap"])(
    "leaves a pinned page with %s",
    (scenario) => {
      const latest = page([4, 5]);
      const opened = openThreadWindow(latest, page([1, 2]));
      const window =
        scenario === "no newer gap"
          ? openThreadWindow(latest, latest)
          : appendNewerThreadPage(opened.snapshot, opened.newerCursor!, page([2, 3, 4, 5]));
      expect(window.newerCursor).toBeNull();
      expect(leaveThreadWindow(window.snapshot, window.newerCursor)).toBe(window.snapshot);

      function Probe() {
        const [snap, setSnap] = useState(window.snapshot);
        const snapRef = useRef(snap);
        const pinnedAroundRef = useRef<{ newerCursor: number | null } | null>(window);
        const jumpScrollTarget = useRef<string | null>("message-4");
        const [scrollState, setThreadScrollState] = useState<ThreadScrollState>({
          detached: false,
          unread: false,
        });
        const scope = {
          pinnedAroundRef,
          joinPinnedAfterLayout: useRef<number | null>(0),
          jumpScrollTarget,
          jumpAnchor: useRef(new ThreadJumpAnchor()),
          expandedHistoryThread: useRef<string | null>("thread-1"),
          scrollBehavior: useRef(new ThreadScrollBehavior()),
          setThreadScrollState,
          publishThreadScrollState: (next: ThreadScrollState) =>
            setThreadScrollState((previous) => reconcileThreadScrollState(previous, next)),
          snapRef,
          commitSnap: setSnap,
          leaveThreadWindow,
        };
        const showLatest = new Function(...Object.keys(scope), `${handler}; return showLatest;`)(
          ...Object.values(scope),
        );
        const pinned = pinnedAroundRef.current != null || jumpScrollTarget.current != null;
        return (
          <>
            <div data-list={pinned ? "pinned" : "live"}>{snap.messages.length}</div>
            {pinned || scrollState.detached ? (
              <button type="button" onClick={showLatest}>
                Jump to latest
              </button>
            ) : null}
          </>
        );
      }

      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        act(() => root.render(<Probe />));
        expect(container.querySelector('[data-list="pinned"]')).not.toBeNull();
        act(() => container.querySelector("button")!.click());
        expect(container.querySelector('[data-list="live"]')).not.toBeNull();
        expect(container.querySelector("button")).toBeNull();
      } finally {
        act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
});
