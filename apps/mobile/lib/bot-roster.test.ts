import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileBot } from "./api";
import { retainUnchangedBotRoster } from "./bot-roster";

function bot(id = "bot-1"): MobileBot {
  return {
    id,
    name: "Helper",
    preview: "",
    title: "",
    color: "gray",
    notifyOnFinish: true,
    threadId: `thread-${id}`,
    pinned: false,
    status: "idle",
    sectionId: null,
    archivedAt: null,
    unread: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    computerMode: "team",
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    autoSpeak: false,
  };
}

afterEach(() => vi.useRealTimers());

describe("thread bot roster", () => {
  it("retains identical RPC data, including differently ordered object keys", () => {
    const current = [bot()];
    const next = [{ ...current[0]!, name: "Helper" }];
    const reordered = [Object.fromEntries(Object.entries(next[0]!).reverse()) as MobileBot];
    expect(retainUnchangedBotRoster(current, next)).toBe(current);
    expect(retainUnchangedBotRoster(current, reordered)).toBe(current);
    const empty: MobileBot[] = [];
    expect(retainUnchangedBotRoster(empty, [])).toBe(empty);
  });

  it("applies field, optional field, membership and ordering changes", () => {
    const current = [bot(), bot("bot-2")];
    for (const next of [
      [{ ...current[0]!, autoSpeak: true }, current[1]!],
      [{ ...current[0]!, name: "Renamed" }, current[1]!],
      [{ ...current[0]!, parentBotId: "parent" }, current[1]!],
      current.slice(1),
      [...current].reverse(),
      [],
    ]) {
      expect(retainUnchangedBotRoster(current, next)).toBe(next);
      expect(retainUnchangedBotRoster(next, current)).toBe(current);
    }
  });

  it("keeps focus independent of reply observation and removes the duplicate mount load", () => {
    const thread = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
    const focus = thread.match(
      /useFocusEffect\(\s*useCallback\(\(\) => \{([\s\S]*?)\}, \[([^\]]*)\]\)/,
    );
    expect(focus?.[2]).toBe("botId, readOnly, markReadIfVisible, refreshMentionBots");
    expect(focus?.[1]).toContain("speakFinishedReplyRef.current()");
    expect(thread).toContain("speakFinishedReplyRef.current = speakFinishedReply");
    expect(thread).toContain(
      "setMentionBots((current) => retainUnchangedBotRoster(current, bots))",
    );
    const mount = thread.match(
      /useEffect\(\(\) => \{([^}]*"groups\/list"[\s\S]*?)\}, \[refreshMentionBots\]\)/,
    );
    expect(mount).not.toBeNull();
    expect(mount?.[1]).not.toContain("refreshMentionBots()");
    expect(thread).toContain('AppState.addEventListener("change", speakFinishedReply)');
    expect(thread).toContain("}, [speakFinishedReply]);");
  });

  it("does not schedule another refresh for identical data (30 s virtual request harness)", () => {
    vi.useFakeTimers();
    // Isolate the audited roster feedback edge: fresh JSON changes the current
    // bot/focus callback; each applied roster loads B routines and 2 connectors.
    // Both versions use 250 ms roster latency and 20 synthetic bots. No network.
    const data = Array.from({ length: 20 }, (_, index) => bot(`bot-${index}`));
    function measure(mode: "before" | "equalityOnly" | "after") {
      let roster: MobileBot[] = [];
      const counts = { roster: 0, related: 0 };
      function refresh() {
        counts.roster++;
        setTimeout(() => {
          const fetched = structuredClone(data);
          const next = mode === "before" ? fetched : retainUnchangedBotRoster(roster, fetched);
          if (next === roster) return;
          roster = next;
          counts.related += roster.length + 2;
          if (mode !== "after") refresh();
        }, 250);
      }
      refresh(); // Focus.
      if (mode === "before") refresh(); // Original duplicate mount fetch.
      vi.advanceTimersByTime(30_000);
      vi.clearAllTimers();
      return counts;
    }
    expect(measure("before")).toEqual({ roster: 242, related: 5_280 });
    // Even with the old data-driven focus edge, equality stops a repeated
    // identical response; the source contract above also removes that edge.
    expect(measure("equalityOnly")).toEqual({ roster: 2, related: 22 });
    expect(measure("after")).toEqual({ roster: 1, related: 22 });
  });
});
