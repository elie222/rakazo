import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserNotificationApi,
  type BrowserNotificationContext,
  browserNotificationMessage,
  deliverBrowserRunNotification,
  requestBrowserNotificationPermission,
  shouldNotifyBrowser,
} from "./browser-notifications.js";
import { i18n } from "./i18n.js";

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
      body: "Finished.",
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

  it("dedupes only after a notification is delivered", () => {
    const notifiedRunIds = new Set<string>();
    const show = vi.fn().mockImplementationOnce(() => {
      throw new Error("notification construction failed");
    });
    const delivery = (permission: "default" | "granted") =>
      deliverBrowserRunNotification(event(), "Chief", {
        enabled: true,
        pageVisible: false,
        windowFocused: false,
        permission,
        notifiedRunIds,
        show,
      });

    expect(delivery("default")).toBe("pending");
    expect(delivery("granted")).toBe("pending");
    expect(notifiedRunIds).toEqual(new Set());
    expect(delivery("granted")).toBe("delivered");
    expect(notifiedRunIds).toEqual(new Set(["run-1"]));
    expect(delivery("granted")).toBe("discarded");
    expect(show).toHaveBeenCalledTimes(2);
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
