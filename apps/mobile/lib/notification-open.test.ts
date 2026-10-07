import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  notificationOpenTarget,
  notificationOpenTargetFromLink,
  notificationResponseRoute,
  threadRouteSpaceOnFocus,
  threadSpaceRequest,
  threadSpaceSwitchResult,
} from "./notification-open.js";

const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";
const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("notification tap routing", () => {
  it("opens the bot thread from an Expo push payload", () => {
    expect(
      notificationOpenTarget({
        kind: "completion",
        botId: "bot-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", threadId: "thread-1" },
    });
  });

  it("keeps the space and the exact thread when the payload has them", () => {
    expect(
      notificationOpenTarget({
        kind: "completion",
        botId: "bot-1",
        threadId: "thread-9",
        spaceId: "space-2",
      }),
    ).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", threadId: "thread-9", spaceId: "space-2" },
    });
  });

  it("opens the group thread when the run belongs to a group", () => {
    expect(
      notificationOpenTarget({
        kind: "completion",
        botId: "bot-1",
        groupId: "group-1",
        threadId: "thread-9",
        spaceId: "space-2",
      }),
    ).toEqual({
      pathname: "/group-thread",
      params: { groupId: "group-1", threadId: "thread-9", spaceId: "space-2" },
    });
  });

  it("reads the Android notification extra keys", () => {
    expect(
      notificationOpenTarget({
        "rakazo.botId": "bot-1",
        "rakazo.threadId": "thread-9",
        "rakazo.spaceId": "space-2",
      }),
    ).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", threadId: "thread-9", spaceId: "space-2" },
    });
  });

  it("opens the thread named by an Android deep link, including its thread id", () => {
    expect(
      notificationOpenTargetFromLink(
        "rakazo://thread?botId=bot-1&name=Ada%20Lovelace&spaceId=space-2&threadId=thread-9",
      ),
    ).toEqual({
      pathname: "/thread",
      params: {
        botId: "bot-1",
        name: "Ada Lovelace",
        spaceId: "space-2",
        threadId: "thread-9",
      },
    });
    expect(
      notificationOpenTargetFromLink(
        "rakazo://group-thread?groupId=group-1&name=Squad&spaceId=space-2&threadId=thread-9",
      ),
    ).toEqual({
      pathname: "/group-thread",
      params: { groupId: "group-1", name: "Squad", spaceId: "space-2", threadId: "thread-9" },
    });
  });

  it("ignores taps that do not name a bot or group", () => {
    expect(notificationOpenTarget(null)).toBeNull();
    expect(notificationOpenTarget({ kind: "completion" })).toBeNull();
    expect(notificationOpenTargetFromLink("https://example.com/thread?botId=bot-1")).toBeNull();
    expect(notificationOpenTargetFromLink("rakazo://account")).toBeNull();
    expect(notificationOpenTargetFromLink("not a url")).toBeNull();
  });

  it("routes only the default tap, which is how a notification opens the app", () => {
    const response = {
      actionIdentifier: DEFAULT_ACTION,
      notification: {
        request: {
          content: { data: { botId: "bot-1", threadId: "thread-1", spaceId: "space-2" } },
        },
      },
    };
    expect(notificationResponseRoute(response, DEFAULT_ACTION)).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", threadId: "thread-1", spaceId: "space-2" },
    });
    expect(
      notificationResponseRoute({ ...response, actionIdentifier: "dismiss" }, DEFAULT_ACTION),
    ).toBeNull();
  });

  it("wires the tap listener for a running app and the last response for a cold start", () => {
    const layout = readFileSync(resolve(mobileRoot, "app/_layout.tsx"), "utf8");
    const opener = readFileSync(resolve(mobileRoot, "lib/open-notification.ts"), "utf8");
    const thread = readFileSync(resolve(mobileRoot, "app/thread.tsx"), "utf8");
    expect(layout).toContain("useNotificationResponses(ready)");
    expect(opener).toContain("addNotificationResponseReceivedListener");
    expect(opener).toContain("useLastNotificationResponse");
    expect(opener).toContain("router.push(target)");
    expect(opener).toContain("Notifications.clearLastNotificationResponse()");
    expect(thread).toContain("threadRouteSpaceOnFocus");
    expect(thread).toContain("useIsFocused()");
  });
});

describe("notification space switch", () => {
  it("shows the thread when the notification is already in the selected space", () => {
    expect(threadSpaceRequest(undefined, "space-1")).toEqual({ action: "show" });
    expect(threadSpaceRequest("space-1", "space-1")).toEqual({ action: "show" });
    expect(threadSpaceRequest(["space-1"], "space-1")).toEqual({ action: "show" });
  });

  it("switches when the notification names a different space", () => {
    expect(threadSpaceRequest("space-2", "space-1")).toEqual({
      action: "switch",
      spaceId: "space-2",
    });
    expect(threadSpaceRequest("space-2", null)).toEqual({ action: "switch", spaceId: "space-2" });
  });

  it("does not pretend a broken space id can be selected", () => {
    expect(threadSpaceRequest("", "space-1")).toEqual({ action: "unavailable" });
    expect(threadSpaceRequest(["space-1", "space-2"], "space-1")).toEqual({
      action: "unavailable",
    });
  });

  it("shows the thread only after the selected space is the one the notification asked for", () => {
    expect(threadSpaceSwitchResult("space-2", true, "space-2")).toBe("ready");
    expect(threadSpaceSwitchResult("space-2", true, "space-1")).toBe("failed");
    expect(threadSpaceSwitchResult("space-2", false, "space-2")).toBe("failed");
  });

  it("adopts the live space when a covered thread route is shown again", () => {
    const next = threadRouteSpaceOnFocus({
      focused: true,
      appliedFocus: false,
      activeSpaceId: "space-1",
      liveSpaceId: "space-2",
      switchFailed: true,
    });
    expect(next).toEqual({
      focused: true,
      appliedFocus: true,
      activeSpaceId: "space-2",
      liveSpaceId: "space-2",
      switchFailed: false,
    });
    expect(threadSpaceRequest("space-1", next.activeSpaceId)).toEqual({
      action: "switch",
      spaceId: "space-1",
    });
  });

  it("keeps showing a route that never named a space", () => {
    const next = threadRouteSpaceOnFocus({
      focused: true,
      appliedFocus: false,
      activeSpaceId: "space-1",
      liveSpaceId: "space-2",
      switchFailed: false,
    });
    expect(threadSpaceRequest(undefined, next.activeSpaceId)).toEqual({ action: "show" });
  });

  it("does not follow a space change while the route stays covered or stays visible", () => {
    const covered = threadRouteSpaceOnFocus({
      focused: false,
      appliedFocus: true,
      activeSpaceId: "space-1",
      liveSpaceId: "space-2",
      switchFailed: false,
    });
    expect(covered.activeSpaceId).toBe("space-1");
    expect(covered.appliedFocus).toBe(false);
    expect(
      threadRouteSpaceOnFocus({
        focused: true,
        appliedFocus: true,
        activeSpaceId: "space-1",
        liveSpaceId: "space-2",
        switchFailed: false,
      }).activeSpaceId,
    ).toBe("space-1");
  });
});
