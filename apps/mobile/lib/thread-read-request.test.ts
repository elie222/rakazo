import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api";
import { ThreadJumpAnchor } from "./thread-jump";
import { mobileVisibleReadSeq } from "./thread-read";

// Exercise the screen's acknowledgement handler without loading native dependencies.
const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const handler = ts.transpileModule(
  `${source.slice(
    source.indexOf("  const markReadIfVisible = useCallback("),
    source.indexOf("  const onViewableItemsChanged = useRef("),
  )}\nreturn markReadIfVisible;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function setup() {
  const snapshot: MobileSnapshot = {
    threadId: "thread-1",
    cursor: 100,
    olderCursor: null,
    run: null,
    readState: { lastReadSeq: 2, lastUnreadSeq: 4, unread: true },
    messages: [3, 4].map((seq) => ({ id: `message-${seq}`, seq, role: "bot", blocks: [] })),
  };
  const pending: Array<(value: unknown) => void> = [];
  const rpc = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
  const scope = {
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    snapRef: { current: snapshot },
    botId: "bot-1",
    groupId: undefined,
    readViewportReady: { current: true },
    pinnedAroundRef: { current: null },
    visibleReadIds: { current: new Set(["message-3"]) },
    readRequest: { current: null as { threadId: string; throughSeq: number } | null },
    readVisit: { current: { threadId: "thread-1", boundary: 2, opened: true } },
    freshReadSnapshot: { current: true },
    openingUnread: { current: false },
    historyEpoch: { current: 1 },
    jumpAnchor: { current: new ThreadJumpAnchor() },
    AppState: { currentState: "active" },
    navigation: { isFocused: () => true },
    readOnly: false,
    headerHeight: 0,
    mobileVisibleReadSeq,
    rpc,
    commitSnap: (next: MobileSnapshot) => {
      scope.snapRef.current = next;
    },
    dismissThreadNotifications: vi.fn(async () => undefined),
  };
  const markRead = new Function(...Object.keys(scope), handler)(
    ...Object.values(scope),
  ) as () => void;
  return { scope, pending, markRead };
}

describe("mobile read acknowledgement races", () => {
  it("acknowledges a newer visible row after the previous request finishes", async () => {
    const { scope, pending, markRead } = setup();
    markRead();
    scope.visibleReadIds.current = new Set(["message-4"]);
    markRead();
    expect(scope.rpc).toHaveBeenCalledTimes(1);
    pending[0]!({ ok: true, readState: { lastReadSeq: 3, lastUnreadSeq: 4, unread: true } });
    await vi.waitFor(() => expect(scope.rpc).toHaveBeenCalledTimes(2));
    expect(scope.rpc).toHaveBeenLastCalledWith("threads/markRead", {
      botId: "bot-1",
      throughSeq: 4,
    });
    pending[1]!({ ok: true, readState: { lastReadSeq: 4, lastUnreadSeq: 4, unread: false } });
    await vi.waitFor(() => expect(scope.readRequest.current).toBeNull());
    expect(scope.rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps a concurrent arrival unread when an older acknowledgement returns", async () => {
    const { scope, pending, markRead } = setup();
    markRead();
    scope.snapRef.current = {
      ...scope.snapRef.current,
      cursor: 101,
      readState: { lastReadSeq: 2, lastUnreadSeq: 5, unread: true },
    };
    pending[0]!({ ok: true, readState: { lastReadSeq: 3, lastUnreadSeq: 3, unread: false } });
    await vi.waitFor(() => expect(scope.readRequest.current).toBeNull());
    expect(scope.snapRef.current.readState?.lastUnreadSeq).toBe(5);
    expect(scope.snapRef.current.readState?.unread).toBe(true);
    expect(scope.rpc).toHaveBeenCalledTimes(1);
  });

  it("drops an acknowledgement overtaken by a clear or thread switch", async () => {
    const { scope, pending, markRead } = setup();
    markRead();
    scope.historyEpoch.current += 1;
    scope.readRequest.current = null;
    scope.snapRef.current = {
      ...scope.snapRef.current,
      messages: [],
      readState: { lastReadSeq: -1, lastUnreadSeq: -1, unread: false },
    };
    pending[0]!({ ok: true, readState: { lastReadSeq: 3, lastUnreadSeq: 3, unread: false } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scope.snapRef.current.readState?.lastReadSeq).toBe(-1);
    expect(scope.rpc).toHaveBeenCalledTimes(1);
  });
});
