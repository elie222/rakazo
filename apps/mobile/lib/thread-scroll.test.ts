import type { ThreadMessage } from "@rakazo/contracts";
import type { ThreadScrollState } from "@rakazo/core";
import { expandPeerReplies, foldPeerReplies, reconcileThreadScrollState } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  isOwnThreadMessage,
  latestArrivalMessage,
  latestThreadRowKey,
  ThreadScrollBehavior,
} from "./thread-scroll.js";

function createScrollBehavior(threadKey = "thread-1") {
  const behavior = new ThreadScrollBehavior();
  behavior.openThread(threadKey);
  return behavior;
}

describe("mobile thread initial scroll", () => {
  it("waits for layout when messages arrive first, then opens at the latest message", () => {
    const behavior = createScrollBehavior();

    expect(behavior.onContentChanged(false, latestThreadRowKey("m1"))).toBe(null);
    expect(behavior.onLayout()).toBe("jump");
  });

  it("opens at the latest message when layout arrives before content", () => {
    const behavior = createScrollBehavior();

    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, latestThreadRowKey("m1"))).toBe("jump");
  });

  it("does not move for expanded labels but smoothly follows a new message", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();

    expect(behavior.onContentChanged(false, latestThreadRowKey("m1"))).toBe("jump");
    expect(behavior.onContentChanged(false, latestThreadRowKey("m1"))).toBe(null);
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2"))).toBe("smooth");
  });

  it("follows a sent message while it waits in the outbox and again when it lands", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1", []));

    expect(behavior.onContentChanged(false, latestThreadRowKey("m1", ["send-1"]))).toBe("smooth");
    expect(behavior.onContentChanged(false, latestThreadRowKey("m1", ["send-1"]))).toBe(null);
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2", []))).toBe("smooth");
  });

  it("does not count a discarded failed send as an arrival", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1", []));
    behavior.onContentChanged(false, latestThreadRowKey("m1", ["send-1"]));
    behavior.onUserScroll(500);

    expect(behavior.onContentChanged(false, latestThreadRowKey("m1", []))).toBe(null);
    expect(behavior.state()).toEqual({ detached: true, unread: false });
  });

  it.each(["bottom", "detached", "drag", "momentum"])(
    "follows outbox and landing after sending from %s",
    (position) => {
      const behavior = createScrollBehavior("thread");
      behavior.onLayout(600);
      behavior.onContentSizeChanged(1800);
      behavior.onContentChanged(false, latestThreadRowKey("m1"));
      if (position !== "bottom") behavior.onUserScroll(500);
      if (position === "drag" || position === "momentum") behavior.onUserDragStart();
      if (position === "momentum") behavior.onUserDragEnd();
      const action = position === "bottom" ? "smooth" : "jump";
      expect(behavior.onOwnSend()).toBe(action);
      behavior.onProgrammaticScroll();
      expect(behavior.isTrackingUserScroll()).toBe(false);
      // Native movement from the interrupted gesture cannot detach the send.
      expect(behavior.onUserScroll(500)).toEqual({ detached: false, unread: false });
      behavior.onUserDragEnd();
      expect(behavior.onUserMomentumEnd()).toBe(action);
      expect(behavior.onContentChanged(false, latestThreadRowKey("bot-before-landing"))).toBe(
        "smooth",
      );
      expect(behavior.state().unread).toBe(false);
      for (const row of [
        latestThreadRowKey("bot-before-landing", ["a"]),
        latestThreadRowKey("m2", [], true),
      ]) {
        behavior.onContentSizeChanged(2000);
        expect(behavior.onContentChanged(false, row)).toBe(action);
        expect(behavior.state()).toEqual({ detached: false, unread: false });
      }
      expect(behavior.onContentChanged(false, latestThreadRowKey("bot"))).toBe("smooth");
      behavior.onUserScroll(500);
      expect(behavior.onContentChanged(false, latestThreadRowKey("bot2"))).toBeNull();
      expect(behavior.state().unread).toBe(true);
    },
  );

  it("does not yank a reader who drags away before their send lands", () => {
    const behavior = createScrollBehavior("thread");
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    behavior.onOwnSend();
    behavior.onContentChanged(false, latestThreadRowKey("m1", ["a"]));
    behavior.onUserDragStart();
    behavior.onUserScroll(500);
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2", [], true))).toBeNull();
    expect(behavior.state()).toEqual({ detached: true, unread: false });
    expect(behavior.onContentChanged(false, latestThreadRowKey("bot", ["b"]))).toBeNull();
    expect(behavior.state()).toEqual({ detached: true, unread: true });
  });

  it("handles an empty thread, two queued sends, and discards without an arrival", () => {
    const behavior = createScrollBehavior("thread");
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey(null, []));
    behavior.onOwnSend();
    for (const row of [
      latestThreadRowKey(null, ["a"]),
      latestThreadRowKey(null, ["a", "b"]),
      latestThreadRowKey("m1", ["b"], true),
      latestThreadRowKey("m2", [], true),
    ]) {
      expect(behavior.onContentChanged(false, row)).toBe("smooth");
      expect(behavior.state()).toEqual({ detached: false, unread: false });
    }
    behavior.onUserDragStart();
    behavior.onUserScroll(500);
    behavior.onContentChanged(false, latestThreadRowKey("m2", ["c", "d"]));
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2", ["c"]))).toBeNull();
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2", []))).toBeNull();
    expect(behavior.state()).toEqual({ detached: true, unread: false });
  });

  it("restores outbox rows without unread and retries even when the row key stays the same", () => {
    const behavior = createScrollBehavior("thread");
    behavior.onLayout();
    const row = latestThreadRowKey(null, ["failed"]);
    expect(behavior.onContentChanged(false, row)).toBe("jump");
    behavior.onUserDragStart();
    behavior.onUserScroll(500);
    expect(behavior.state()).toEqual({ detached: true, unread: false });
    expect(behavior.onOwnSend()).toBe("jump");
    expect(behavior.onContentChanged(false, row)).toBeNull();
    expect(behavior.state()).toEqual({ detached: false, unread: false });
    expect(behavior.onContentChanged(false, latestThreadRowKey("own", [], true))).toBe("jump");
  });

  it("retains the send intent while a pinned page blocks the live list", () => {
    const behavior = createScrollBehavior("thread");
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    behavior.onUserDragStart();
    behavior.onUserScroll(500);
    behavior.onOwnSend();
    const row = latestThreadRowKey("m1", ["a"]);
    expect(behavior.onContentChanged(true, row)).toBeNull();
    expect(behavior.state()).toEqual({ detached: false, unread: false });
    expect(behavior.onLayout()).toBe("jump");
    expect(behavior.onContentChanged(false, row)).toBe("jump");
  });

  it("keeps the latest message visible when the viewport resizes", () => {
    const behavior = createScrollBehavior();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));

    expect(behavior.onLayout()).toBe("jump");
    expect(behavior.onLayout()).toBe("jump");
  });

  it("keeps the initial jump pending while another scroll target blocks it", () => {
    const behavior = createScrollBehavior();

    expect(behavior.onContentChanged(true, latestThreadRowKey("m1"))).toBe(null);
    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, latestThreadRowKey("m1"))).toBe("jump");
    expect(behavior.onContentChanged(false, latestThreadRowKey("m1"))).toBe(null);
  });

  it("leaves a detached reader in place and records unread messages", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));

    expect(behavior.onUserScroll(120)).toEqual({ detached: true, unread: false });
    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2"))).toBe(null);
    expect(behavior.state()).toEqual({ detached: true, unread: true });
    expect(behavior.jumpToLatest()).toBe("smooth");
    expect(behavior.state()).toEqual({ detached: false, unread: false });
  });

  it("skips auto-follow during a drag and tracks the fling past the detach threshold", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout(600);
    behavior.onContentSizeChanged(1800);
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    behavior.onUserDragStart();
    behavior.onUserScroll(50);

    expect(behavior.onContentChanged(false, latestThreadRowKey("m2"))).toBe(null);
    // Even an explicit programmatic scroll must preserve the active finger.
    behavior.onProgrammaticScroll();
    expect(behavior.isTrackingUserScroll()).toBe(true);
    behavior.onUserScroll(70);
    behavior.onUserDragEnd();
    expect(behavior.isTrackingUserScroll()).toBe(true);
    if (behavior.isTrackingUserScroll()) behavior.onUserScroll(150);
    behavior.onUserMomentumEnd();
    expect(behavior.isTrackingUserScroll()).toBe(false);
    expect(behavior.state()).toEqual({ detached: true, unread: false });
    expect(behavior.onContentChanged(false, latestThreadRowKey("m3"))).toBe(null);
    expect(behavior.state()).toEqual({ detached: true, unread: true });
  });

  it("defers auto-follow until momentum ends and re-enables tracking for a new drag", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    behavior.onUserDragStart();
    behavior.onUserScroll(50);
    behavior.onUserDragEnd();
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2"))).toBe(null);
    expect(behavior.isTrackingUserScroll()).toBe(true);
    expect(behavior.onUserMomentumEnd()).toBe("smooth");
    expect(behavior.state()).toEqual({ detached: false, unread: false });
    behavior.onProgrammaticScroll();
    expect(behavior.isTrackingUserScroll()).toBe(false);
    behavior.onUserDragStart();
    expect(behavior.isTrackingUserScroll()).toBe(true);
    // Completion of the interrupted animation cannot cancel the new drag.
    behavior.onUserMomentumEnd();
    expect(behavior.isTrackingUserScroll()).toBe(true);
    behavior.onUserScroll(150);
    expect(behavior.state().detached).toBe(true);
    behavior.openThread("thread-2");
    expect(behavior.isTrackingUserScroll()).toBe(false);
    behavior.onLayout();
    expect(behavior.onContentChanged(false, latestThreadRowKey("m3"))).toBe("jump");
    expect(behavior.onContentChanged(false, latestThreadRowKey("m4"))).toBe("smooth");
  });

  it("does not interrupt a fling below the threshold, then shows unread when it ends detached", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    behavior.onUserDragStart();
    behavior.onUserScroll(50);
    behavior.onUserDragEnd();

    expect(behavior.onContentChanged(false, latestThreadRowKey("m2"))).toBe(null);
    expect(behavior.onLayout()).toBe(null);
    expect(behavior.isTrackingUserScroll()).toBe(true);
    expect(behavior.onUserScroll(150)).toEqual({ detached: true, unread: true });
    expect(behavior.onUserMomentumEnd()).toBe(null);
    expect(behavior.isTrackingUserScroll()).toBe(false);
    expect(behavior.state()).toEqual({ detached: true, unread: true });
    // Catching up clears the button and does not replay the deferred arrival.
    behavior.onUserDragStart();
    behavior.onUserScroll(80);
    behavior.onUserDragEnd();
    expect(behavior.onUserMomentumEnd()).toBe(null);
    expect(behavior.state()).toEqual({ detached: false, unread: false });
  });

  it("settles on idle without momentum-end, but never while a finger is down", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    behavior.onUserDragStart();
    behavior.onUserScroll(80);
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2"))).toBe(null);
    // The idle fallback and native momentum-end use the same settlement path.
    expect(behavior.onUserMomentumEnd()).toBe(null);
    expect(behavior.isTrackingUserScroll()).toBe(true);
    behavior.onUserDragEnd();
    expect(behavior.onUserMomentumEnd()).toBe("smooth");
    expect(behavior.isTrackingUserScroll()).toBe(false);
    expect(behavior.state()).toEqual({ detached: false, unread: false });
    expect(behavior.onUserMomentumEnd()).toBe(null);
    expect(behavior.onContentChanged(false, latestThreadRowKey("m3"))).toBe("smooth");
    behavior.onUserDragStart();
    behavior.onUserDragEnd();
    expect(behavior.onUserMomentumEnd()).toBe(null);
    expect(behavior.isTrackingUserScroll()).toBe(false);
  });

  it("catches up after an arrival while detached when the same fling ends near latest", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    behavior.onUserDragStart();
    behavior.onUserScroll(200);
    behavior.onUserDragEnd();
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2"))).toBe(null);
    expect(behavior.state()).toEqual({ detached: true, unread: true });
    behavior.onUserScroll(80);
    expect(behavior.onUserMomentumEnd()).toBe("smooth");
    expect(behavior.state()).toEqual({ detached: false, unread: false });
    expect(behavior.isTrackingUserScroll()).toBe(false);
  });

  it("discards deferred following when switching threads", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    behavior.onUserDragStart();
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2"))).toBe(null);
    behavior.onUserDragEnd();
    behavior.openThread("thread-2");
    expect(behavior.onUserMomentumEnd()).toBe(null);
    expect(behavior.isTrackingUserScroll()).toBe(false);
  });

  it.each(["content", "viewport"])(
    "clamps distance and clears unread when %s measurements leave at most 80 points to scroll",
    (measurement) => {
      const behavior = createScrollBehavior();
      behavior.onLayout(600);
      behavior.onContentSizeChanged(1800);
      behavior.onContentChanged(false, latestThreadRowKey("m1"));
      behavior.onUserScroll(500);
      behavior.onContentChanged(false, latestThreadRowKey("m2"));
      const resize = (remaining: number) => {
        if (measurement === "content") behavior.onContentSizeChanged(600 + remaining);
        else behavior.onLayout(1800 - remaining);
      };

      resize(81);
      expect(behavior.state()).toEqual({ detached: true, unread: true });
      resize(80);
      expect(behavior.state()).toEqual({ detached: false, unread: false });
      // Increasing the range again must not restore the stale distance or unread state.
      resize(1200);
      expect(behavior.state()).toEqual({ detached: false, unread: false });
    },
  );

  it("skips state commits during a 2 s detached drag of 120 scroll events", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    const initial = behavior.onUserScroll(120);
    let before = initial;
    let after = initial;
    let beforeCommits = 0;
    let afterCommits = 0;
    const publish = (next: ThreadScrollState) => {
      if (!Object.is(before, next)) beforeCommits += 1;
      before = next;
      const reconciled = reconcileThreadScrollState(after, next);
      if (!Object.is(after, reconciled)) afterCommits += 1;
      after = reconciled;
      expect(after).toEqual(before);
    };

    // 60 events/s for 2 s, with every offset above the detach threshold.
    for (let event = 0; event < 120; event += 1) {
      publish(behavior.onUserScroll(120 + event));
    }
    expect({ beforeCommits, afterCommits }).toEqual({ beforeCommits: 120, afterCommits: 0 });
    expect(after).toBe(initial);

    // Layout and unchanged content must preserve the same visible state too.
    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, latestThreadRowKey("m1"))).toBe(null);
    publish(behavior.state());
    expect(afterCommits).toBe(0);

    // Unread arrival and reattachment still publish their visible transitions.
    expect(behavior.onContentChanged(false, latestThreadRowKey("m2"))).toBe(null);
    publish(behavior.state());
    expect(afterCommits).toBe(1);
    expect(after).toEqual({ detached: true, unread: true });
    publish(behavior.onUserScroll(80));
    expect(afterCommits).toBe(2);
    expect(after).toEqual({ detached: false, unread: false });
  });
  it("publishes only threshold crossings throughout a fling and clears unread near latest", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout(600);
    behavior.onContentSizeChanged(1800);
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    let state = behavior.state();
    let commits = 0;
    const scroll = (offset: number) => {
      const next = reconcileThreadScrollState(state, behavior.onUserScroll(offset));
      if (next !== state) commits += 1;
      state = next;
    };

    // The finger lifts below the threshold; momentum continues away from latest.
    for (const offset of [0, 30, 70, 81, 150, 300, 500]) scroll(offset);
    expect(commits).toBe(1);
    expect(state.detached).toBe(true);
    behavior.onContentChanged(false, latestThreadRowKey("m2"));
    state = behavior.state();
    expect(state.unread).toBe(true);
    // A fling towards latest reattaches before momentum ends.
    for (const offset of [400, 200, 81, 80, 30, 0, -20]) scroll(offset);
    expect(commits).toBe(2);
    expect(state).toEqual({ detached: false, unread: false });
  });

  it("ignores bounce on short threads and reattaches when content or viewport stops scrolling", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout(600);
    behavior.onContentSizeChanged(400);
    expect(behavior.onUserScroll(100)).toEqual({ detached: false, unread: false });
    behavior.onContentSizeChanged(1200);
    expect(behavior.onUserScroll(100).detached).toBe(true);
    behavior.onLayout(1200);
    expect(behavior.state().detached).toBe(false);
    behavior.onLayout(600);
    behavior.onUserScroll(100);
    expect(behavior.onContentSizeChanged(600)).toEqual({ detached: false, unread: false });
  });

  it("keeps a tap reattached when content resizes before the smooth scroll finishes", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout(600);
    behavior.onContentSizeChanged(1200);
    behavior.onContentChanged(false, latestThreadRowKey("m1"));
    behavior.onUserScroll(300);
    behavior.onContentChanged(false, latestThreadRowKey("m2"));
    expect(behavior.jumpToLatest()).toBe("smooth");
    expect(behavior.onContentSizeChanged(1300)).toEqual({ detached: false, unread: false });
  });
});

describe("mobile thread folded peer replies", () => {
  const markerOf = new Map([["reply", "marker"]]);
  const collapsed = [{ id: "user" }, { id: "marker" }];
  const expanded = [...collapsed, { id: "reply" }];

  it("returns the arrival message and handles lists without an arrival", () => {
    expect(latestArrivalMessage(expanded, markerOf)).toBe(collapsed[1]);
    expect(latestArrivalMessage([], markerOf)).toBeUndefined();
    expect(latestArrivalMessage([{ id: "reply" }], markerOf)).toBeUndefined();
  });

  it("ignores hidden arrivals and fold toggles but marks an inline ask unread", () => {
    const messages: ThreadMessage[] = [
      {
        id: "marker",
        threadId: "thread-1",
        seq: 1,
        createdAt: "2026-10-19T00:00:00Z",
        role: "user",
        runId: "peer-run",
        blocks: [
          { kind: "bot_message_received", fromBotId: "peer", fromBotName: "Peer", text: "Done" },
        ],
      },
    ];
    const behavior = createScrollBehavior();
    behavior.onLayout(600);
    behavior.onContentSizeChanged(1800);
    const arrive = (expandedMarkers: ReadonlySet<string>) => {
      const transcript = foldPeerReplies(messages, { includePeerReceipts: true });
      return behavior.onContentChanged(
        false,
        latestThreadRowKey(
          latestArrivalMessage(expandPeerReplies(transcript, expandedMarkers), transcript.markerOf)
            ?.id ?? null,
        ),
      );
    };
    expect(arrive(new Set())).toBe("jump");
    behavior.onUserScroll(200);
    messages.push({
      ...messages[0]!,
      id: "reply",
      seq: 2,
      role: "bot",
      blocks: [{ kind: "text", text: "Peer summary" }],
    });
    for (const expandedMarkers of [new Set<string>(), new Set(["marker"]), new Set<string>()]) {
      expect(arrive(expandedMarkers)).toBeNull();
      expect(behavior.state()).toEqual({ detached: true, unread: false });
    }
    messages.push({
      ...messages[0]!,
      id: "ask",
      seq: 3,
      role: "bot",
      blocks: [{ kind: "ask", text: "Which city?", status: "pending" }],
    });
    expect(arrive(new Set())).toBeNull();
    expect(behavior.state()).toEqual({ detached: true, unread: true });
    expect(arrive(new Set(["marker"]))).toBeNull();
    expect(behavior.state()).toEqual({ detached: true, unread: true });
    expect(behavior.jumpToLatest()).toBe("smooth");
    expect(behavior.state()).toEqual({ detached: false, unread: false });
  });

  it("does not count collapsing a fold at the end as a new message", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(
      false,
      latestThreadRowKey(latestArrivalMessage(collapsed, markerOf)?.id ?? null),
    );
    behavior.onContentChanged(
      false,
      latestThreadRowKey(latestArrivalMessage(expanded, markerOf)?.id ?? null),
    );

    behavior.onUserScroll(200);
    behavior.onContentChanged(
      false,
      latestThreadRowKey(latestArrivalMessage(collapsed, markerOf)?.id ?? null),
    );
    expect(behavior.state()).toEqual({ detached: true, unread: false });
  });

  it("does not follow an expanded fold as if a message arrived", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(
      false,
      latestThreadRowKey(latestArrivalMessage(collapsed, markerOf)?.id ?? null),
    );

    expect(
      behavior.onContentChanged(
        false,
        latestThreadRowKey(latestArrivalMessage(expanded, markerOf)?.id ?? null),
      ),
    ).toBe(null);
  });

  it("still records a real new row after the marker while detached", () => {
    const behavior = createScrollBehavior();
    behavior.onLayout();
    behavior.onContentChanged(
      false,
      latestThreadRowKey(latestArrivalMessage(expanded, markerOf)?.id ?? null),
    );

    behavior.onUserScroll(200);
    behavior.onContentChanged(
      false,
      latestThreadRowKey(latestArrivalMessage([...expanded, { id: "new" }], markerOf)?.id ?? null),
    );
    expect(behavior.state()).toEqual({ detached: true, unread: true });
  });
});

describe("message ownership", () => {
  const message = { role: "user" as const, blocks: [] };
  it("uses the human author when available and falls back for older messages", () => {
    expect(isOwnThreadMessage({ ...message, userId: "me" }, "me")).toBe(true);
    expect(isOwnThreadMessage({ ...message, userId: "other" }, "me")).toBe(false);
    expect(isOwnThreadMessage(message, "me")).toBe(true);
    expect(isOwnThreadMessage({ ...message, role: "bot" }, "me")).toBe(false);
    expect(isOwnThreadMessage(undefined, "me")).toBe(false);
    expect(
      isOwnThreadMessage(
        {
          ...message,
          blocks: [
            { kind: "bot_message_received", fromBotId: "bot", fromBotName: "Bot", text: "Hi" },
          ],
        },
        "me",
      ),
    ).toBe(false);
  });
  it("marks another member's arrival unread while detached", () => {
    const behavior = createScrollBehavior("thread");
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("initial"));
    behavior.onUserScroll(500);
    expect(
      behavior.onContentChanged(
        false,
        latestThreadRowKey("other", [], isOwnThreadMessage({ ...message, userId: "other" }, "me")),
      ),
    ).toBeNull();
    expect(behavior.state()).toEqual({ detached: true, unread: true });
  });
  it("ends send following when its outbox row is discarded", () => {
    const behavior = createScrollBehavior("thread");
    behavior.onLayout();
    behavior.onContentChanged(false, latestThreadRowKey("initial"));
    behavior.onUserScroll(500);
    behavior.onOwnSend();
    behavior.onContentChanged(false, latestThreadRowKey("initial", ["send"]));
    expect(behavior.onContentChanged(false, latestThreadRowKey("bot", ["send"]))).toBe("smooth");
    expect(behavior.onContentChanged(false, latestThreadRowKey("bot", []))).toBeNull();
    behavior.onUserScroll(500);
    behavior.onContentChanged(false, latestThreadRowKey("reply"));
    expect(behavior.state().unread).toBe(true);
  });
});
