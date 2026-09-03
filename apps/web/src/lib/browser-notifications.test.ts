import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserNotificationApi,
  type BrowserNotificationContext,
  browserNotificationMessage,
  deliverBrowserNotification,
  requestBrowserNotificationPermission,
  shouldNotifyBrowser,
} from "./browser-notifications.js";
import { i18n } from "./i18n.js";

function event(
  overrides: Partial<{
    type:
      | "thread.message.created"
      | "run.completed"
      | "run.failed"
      | "run.cancelled"
      | "run.started";
    threadId: string;
    id: string;
    runId: string;
    seq: number;
    payload: Record<string, unknown>;
  }> = {},
) {
  return {
    type: "thread.message.created" as const,
    id: "event-1",
    threadId: "thread-1",
    runId: "run-1",
    seq: 8,
    payload: { role: "bot", blocks: [{ kind: "text", text: "The pool is balanced." }] },
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
    notifiedEventIds: new Set(),
    ...overrides,
  };
}

describe("browser notifications", () => {
  beforeEach(() => {
    i18n.load("en", {
      "{name} failed": "Chief failed",
      "{name} finished": "Chief finished",
      "{name} stopped": "Chief stopped",
      "Failed.": "Failed.",
      "Stopped.": "Stopped.",
      "Finished.": "Finished.",
    });
    i18n.activate("en");
  });

  it("only accepts a new bot message for the hidden or unfocused subscribed thread", () => {
    expect(shouldNotifyBrowser(event(), context())).toBe(true);
    expect(shouldNotifyBrowser(event({ type: "run.started" }), context())).toBe(false);
    expect(shouldNotifyBrowser(event({ type: "run.failed" }), context())).toBe(true);
    expect(shouldNotifyBrowser(event({ type: "run.cancelled" }), context())).toBe(true);
    expect(shouldNotifyBrowser(event({ payload: { role: "user", blocks: [] } }), context())).toBe(
      false,
    );
    expect(shouldNotifyBrowser(event({ type: "run.completed" }), context())).toBe(false);
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
    expect(shouldNotifyBrowser(event(), context({ notifiedEventIds: new Set(["event-1"]) }))).toBe(
      false,
    );
  });

  it("puts the bot message in the native notification", () => {
    expect(browserNotificationMessage(event(), "Chief")).toEqual({
      title: "Chief",
      body: "The pool is balanced.",
    });
    expect(browserNotificationMessage(event({ type: "run.failed" }), "Chief")).toEqual({
      title: "Chief failed",
      body: "Failed.",
    });
    expect(browserNotificationMessage(event({ type: "run.cancelled" }), "Chief")).toEqual({
      title: "Chief stopped",
      body: "Stopped.",
    });
  });

  it("dedupes a replay but delivers another message from the same run", () => {
    const notifiedEventIds = new Set<string>();
    const show = vi.fn().mockImplementationOnce(() => {
      throw new Error("notification construction failed");
    });
    const delivery = (permission: "default" | "granted", nextEvent = event()) =>
      deliverBrowserNotification(nextEvent, "Chief", {
        enabled: true,
        pageVisible: false,
        windowFocused: false,
        permission,
        notifiedEventIds,
        show,
      });

    expect(delivery("default")).toBe("pending");
    expect(delivery("granted")).toBe("pending");
    expect(notifiedEventIds).toEqual(new Set());
    expect(delivery("granted")).toBe("delivered");
    expect(notifiedEventIds).toEqual(new Set(["event-1"]));
    expect(show).toHaveBeenLastCalledWith("Chief", "The pool is balanced.", "thread-1");
    expect(delivery("granted")).toBe("discarded");
    expect(delivery("granted", event({ id: "event-2" }))).toBe("delivered");
    expect(show).toHaveBeenCalledTimes(3);
  });

  it("allows a later send gesture to retry a dismissed permission prompt", async () => {
    let resolvePermission: ((permission: "default") => void) | undefined;
    const requestPermission = vi.fn(
      () =>
        new Promise<"default">((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const api: BrowserNotificationApi = { permission: "default", requestPermission };

    requestBrowserNotificationPermission(api);
    requestBrowserNotificationPermission(api);
    expect(requestPermission).toHaveBeenCalledTimes(1);

    resolvePermission?.("default");
    await Promise.resolve();
    requestBrowserNotificationPermission(api);
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });
});
