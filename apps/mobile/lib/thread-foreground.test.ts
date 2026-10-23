import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the screen's subscription effects without loading native UI dependencies.
const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const start = source.indexOf("  useEffect(() => {\n    liveCursor.current = null;");
const effects = ts.transpileModule(
  source.slice(start, source.indexOf("  useEffect(() => () => pendingSave", start)),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

const ref = <T>(current: T) => ({ current });

describe("thread foreground subscription", () => {
  it.each(["latest", "expanded", "search"])(
    "replays missed updates and clears in the %s window, but starts fresh for another chat",
    async (mode) => {
      const applied: number[] = [];
      const cursors: number[] = [];
      let deliver: (event: { type: string; seq: number; runId?: string }) => void = () => {};
      const hooks: { deps: unknown[]; cleanup?: () => void }[] = [];
      let hookIndex = 0;
      const snapshot = { cursor: 10 };
      const scope = {
        useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
          const index = hookIndex++;
          const previous = hooks[index];
          if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: effect() };
        },
        botId: "bot-1",
        groupId: undefined,
        foreground: true,
        readOnly: false,
        sessionEpoch: 1,
        messageId: mode === "search" ? "message-1" : undefined,
        liveCursor: ref<number | null>(null),
        historyEpoch: ref(0),
        liveSubscriptionGeneration: ref(0),
        liveSubscribed: ref(false),
        currentSessionGeneration: () => 1,
        showSavedThread: vi.fn(),
        rpc: vi.fn(async () => snapshot),
        refresh: vi.fn(async () => snapshot),
        setError: vi.fn(),
        errorText: String,
        subscribeThread: vi.fn(
          async (
            _target: unknown,
            cursor: number,
            onEvent: typeof deliver,
            signal: AbortSignal,
          ) => {
            cursors.push(cursor);
            deliver = onEvent;
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          },
        ),
        expandedHistoryThread: ref<string | null>(mode === "latest" ? null : "thread-1"),
        pinnedAroundRef: ref(mode === "search" ? {} : null),
        jumpScrollTarget: ref<string | null>(mode === "search" ? "message-1" : null),
        jumpAnchor: ref({ release: vi.fn() }),
        snapRef: ref(snapshot),
        commitSnap: vi.fn(),
        applyMobileThreadEvent: (_snapshot: unknown, event: { seq: number }) => {
          applied.push(event.seq);
          return snapshot;
        },
        isRunTerminalEvent: () => false,
        refreshMentionBots: vi.fn(),
        readVisibleTarget: ref(null),
        markReadIfVisible: vi.fn(),
        abortableDelay: vi.fn(),
      };
      const render = async () => {
        hookIndex = 0;
        new Function(...Object.keys(scope), effects)(...Object.values(scope));
        await Promise.resolve();
        await Promise.resolve();
      };
      await render();
      deliver({ type: "thread.message.updated", seq: 11 });
      scope.refresh.mockClear();
      // Another device paused a run; the event has no owner to expose Dismiss.
      deliver({ type: "run.waiting_input", seq: 12, runId: "run-other-device" });
      expect(applied).toEqual([11, 12]);
      expect(scope.refresh).toHaveBeenCalledTimes(mode === "latest" ? 1 : 0);
      expect(scope.refreshMentionBots).not.toHaveBeenCalled();
      scope.foreground = false;
      await render();
      // A late callback from the aborted stream must not advance the saved cursor.
      deliver({ type: "thread.message.updated", seq: 13 });
      snapshot.cursor = 20;
      scope.foreground = true;
      await render();
      expect(cursors).toEqual([10, 12]);
      deliver({ type: "thread.message.updated", seq: 13 });
      deliver({ type: "thread.cleared", seq: 14 });
      expect(applied).toEqual([11, 12, 13, 14]);
      expect(scope.expandedHistoryThread.current).toBeNull();
      expect(scope.pinnedAroundRef.current).toBeNull();
      expect(scope.jumpScrollTarget.current).toBeNull();
      scope.botId = "bot-2";
      await render();
      expect(cursors).toEqual([10, 12, 20]);
      for (const hook of hooks) hook.cleanup?.();
    },
  );
});
