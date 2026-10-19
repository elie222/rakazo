import type { ThreadScrollState } from "@rakazo/core";
import { reconcileThreadScrollState } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { ThreadScrollBehavior } from "./thread-scroll.js";

describe("mobile thread initial scroll", () => {
  it("waits for layout when messages arrive first, then opens at the latest message", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");

    expect(behavior.onContentChanged(false, "m1")).toBe(null);
    expect(behavior.onLayout()).toBe("jump");
  });

  it("opens at the latest message when layout arrives before content", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");

    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, "m1")).toBe("jump");
  });

  it("does not move for expanded labels but smoothly follows a new message", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");
    behavior.onLayout();

    expect(behavior.onContentChanged(false, "m1")).toBe("jump");
    expect(behavior.onContentChanged(false, "m1")).toBe(null);
    expect(behavior.onContentChanged(false, "m2")).toBe("smooth");
  });

  it("keeps the latest message visible when the viewport resizes", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");
    behavior.onContentChanged(false, "m1");

    expect(behavior.onLayout()).toBe("jump");
    expect(behavior.onLayout()).toBe("jump");
  });

  it("keeps the initial jump pending while another scroll target blocks it", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");

    expect(behavior.onContentChanged(true, "m1")).toBe(null);
    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, "m1")).toBe("jump");
    expect(behavior.onContentChanged(false, "m1")).toBe(null);
  });

  it("leaves a detached reader in place and records unread messages", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");
    behavior.onLayout();
    behavior.onContentChanged(false, "m1");

    expect(behavior.onUserScroll(120)).toEqual({ detached: true, unread: false });
    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, "m2")).toBe(null);
    expect(behavior.state()).toEqual({ detached: true, unread: true });
    expect(behavior.jumpToLatest()).toBe("smooth");
    expect(behavior.state()).toEqual({ detached: false, unread: false });
  });

  it("skips state commits during a 2 s detached drag of 120 scroll events", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");
    behavior.onLayout();
    behavior.onContentChanged(false, "m1");
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
    expect(behavior.onContentChanged(false, "m1")).toBe(null);
    publish(behavior.state());
    expect(afterCommits).toBe(0);

    // Unread arrival and reattachment still publish their visible transitions.
    expect(behavior.onContentChanged(false, "m2")).toBe(null);
    publish(behavior.state());
    expect(afterCommits).toBe(1);
    expect(after).toEqual({ detached: true, unread: true });
    publish(behavior.onUserScroll(80));
    expect(afterCommits).toBe(2);
    expect(after).toEqual({ detached: false, unread: false });
  });
});
