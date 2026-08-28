import { describe, expect, it } from "vitest";
import {
  type BrowserNotificationContext,
  browserNotificationMessage,
  shouldNotifyBrowser,
} from "./browser-notifications.js";

function event(
  overrides: Partial<{
    type: "run.completed" | "run.failed" | "run.cancelled" | "run.started";
    threadId: string;
    runId: string;
    seq: number;
  }> = {},
) {
  return {
    type: "run.completed" as const,
    threadId: "thread-1",
    runId: "run-1",
    seq: 8,
    ...overrides,
  };
}

function context(overrides: Partial<BrowserNotificationContext> = {}): BrowserNotificationContext {
  return {
    subscribedThreadId: "thread-1",
    initialCursor: 7,
    streamReady: true,
    pageVisible: false,
    windowFocused: false,
    permission: "granted",
    notifiedRunIds: new Set(),
    ...overrides,
  };
}

describe("browser run notifications", () => {
  it("only accepts a new terminal event for the hidden or unfocused subscribed thread", () => {
    expect(shouldNotifyBrowser(event(), context())).toBe(true);
    expect(shouldNotifyBrowser(event({ type: "run.started" }), context())).toBe(false);
    expect(shouldNotifyBrowser(event({ threadId: "other-thread" }), context())).toBe(false);
    expect(shouldNotifyBrowser(event({ seq: 7 }), context())).toBe(false);
    expect(shouldNotifyBrowser(event(), context({ pageVisible: true, windowFocused: false }))).toBe(
      true,
    );
    expect(shouldNotifyBrowser(event(), context({ pageVisible: false, windowFocused: true }))).toBe(
      true,
    );
    expect(shouldNotifyBrowser(event(), context({ streamReady: false }))).toBe(false);
    expect(shouldNotifyBrowser(event(), context({ pageVisible: true, windowFocused: true }))).toBe(
      false,
    );
    expect(shouldNotifyBrowser(event(), context({ permission: "default" }))).toBe(false);
    expect(shouldNotifyBrowser(event(), context({ notifiedRunIds: new Set(["run-1"]) }))).toBe(
      false,
    );
  });

  it("keeps terminal copy stable for the native Notification API", () => {
    expect(browserNotificationMessage(event(), "Chief")).toEqual({
      title: "Chief finished",
      body: "Your bot finished its work.",
    });
    expect(browserNotificationMessage(event({ type: "run.failed" }), "Chief")).toEqual({
      title: "Chief failed",
      body: "Your bot run failed.",
    });
  });
});
