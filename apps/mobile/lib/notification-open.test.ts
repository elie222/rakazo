import { describe, expect, it } from "vitest";
import {
  notificationOpenTarget,
  notificationOpenTargetFromLink,
  notificationResponseRoute,
  threadRouteId,
  threadRouteSpaceOnFocus,
  threadSpaceRequest,
  threadSpaceSwitchResult,
} from "./notification-open.js";

const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

describe("thread route identity", () => {
  it("reuses a chat screen for the same bot or group", () => {
    expect(threadRouteId("thread", { botId: "bot-1", name: "Ada" })).toBe(
      threadRouteId("thread", { botId: "bot-1", threadId: "thread-1", spaceId: "space-1" }),
    );
    expect(threadRouteId("group-thread", { botId: "bot-1", groupId: "group-1" })).toBe(
      threadRouteId("group-thread", { botId: "bot-2", groupId: "group-1" }),
    );
  });

  it("keeps different bots and group chats distinct", () => {
    const bot = threadRouteId("thread", { botId: "bot-1" });
    expect(bot).not.toBe(threadRouteId("thread", { botId: "bot-2" }));
    expect(bot).not.toBe(threadRouteId("group-thread", { botId: "bot-1", groupId: "group-1" }));
  });

  it("does not assign an identity without a bot or group", () => {
    expect(threadRouteId("thread", {})).toBeUndefined();
    expect(threadRouteId("thread", { botId: "" })).toBeUndefined();
    expect(threadRouteId("thread", { botId: ["bot-1", "bot-2"] })).toBeUndefined();
  });
});

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
