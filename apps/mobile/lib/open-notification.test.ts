import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  addNotificationResponseReceivedListener: vi.fn(),
  clearLastNotificationResponse: vi.fn(),
  getLastNotificationResponse: vi.fn(),
  useLastNotificationResponse: vi.fn(),
}));
vi.mock("expo-router", () => ({
  router: { push: vi.fn() },
}));
vi.mock("./api", () => ({
  loadSessionToken: vi.fn(),
}));

import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { loadSessionToken } from "./api";
import { openNotificationResponse } from "./open-notification";

const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

function tap(id: string, data: Record<string, unknown> = { botId: "bot-1", threadId: "thread-1" }) {
  return {
    actionIdentifier: DEFAULT_ACTION,
    notification: { request: { identifier: id, content: { data } } },
  } as Notifications.NotificationResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("opening a notification tap", () => {
  it("opens a signed-in tap once when the cold start and the listener both see it", async () => {
    let release: (token: string) => void = () => undefined;
    vi.mocked(loadSessionToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const response = tap("tap-signed-in");
    const first = openNotificationResponse(response);
    const second = openNotificationResponse(response);
    release("token");
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/thread",
      params: { botId: "bot-1", threadId: "thread-1" },
    });
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  it("drops a signed-out tap so a later cold start cannot replay it", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("");
    const response = tap("tap-signed-out", {
      botId: "bot-1",
      threadId: "thread-1",
      spaceId: "space-2",
    });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(response);
    await expect(openNotificationResponse(response)).resolves.toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);

    vi.mocked(loadSessionToken).mockResolvedValue("token");
    await expect(openNotificationResponse(response)).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("leaves the last response in place when the tap cannot be opened or the session read fails", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("");
    await expect(openNotificationResponse(null)).resolves.toBe(false);
    await expect(openNotificationResponse(tap("tap-empty", { kind: "completion" }))).resolves.toBe(
      false,
    );
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    vi.mocked(loadSessionToken).mockRejectedValue(new Error("locked"));
    await expect(openNotificationResponse(tap("tap-locked"))).resolves.toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    vi.mocked(loadSessionToken).mockResolvedValue("token");
    await expect(openNotificationResponse(tap("tap-locked"))).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("leaves a newer last response in place when an older signed-out tap is rejected", async () => {
    let release: (token: string) => void = () => undefined;
    vi.mocked(loadSessionToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const older = tap("tap-older");
    const newer = tap("tap-newer", { botId: "bot-2", threadId: "thread-2" });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(older);
    const pending = openNotificationResponse(older);
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(newer);
    release("");
    await expect(pending).resolves.toBe(false);
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    vi.mocked(loadSessionToken).mockResolvedValue("token");
    await expect(openNotificationResponse(newer)).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/thread",
      params: { botId: "bot-2", threadId: "thread-2" },
    });
  });

  it("treats two deliveries that share a request identifier as different taps", async () => {
    const releases: Array<(token: string) => void> = [];
    vi.mocked(loadSessionToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const shared = { botId: "bot-1", threadId: "thread-1" };
    const older = tap("thread-shared-out", { ...shared, deliveryId: "delivery-out-1" });
    const newer = tap("thread-shared-out", { ...shared, deliveryId: "delivery-out-2" });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(older);
    const pendingOlder = openNotificationResponse(older);
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(newer);
    const pendingNewer = openNotificationResponse(newer);

    releases[0]?.("");
    await expect(pendingOlder).resolves.toBe(false);
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    releases[1]?.("token");
    await expect(pendingNewer).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("opens both signed-in deliveries that share a request identifier", async () => {
    const releases: Array<(token: string) => void> = [];
    vi.mocked(loadSessionToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const shared = { botId: "bot-1", threadId: "thread-1" };
    const first = tap("thread-shared-in", { ...shared, deliveryId: "delivery-in-1" });
    const second = tap("thread-shared-in", { ...shared, deliveryId: "delivery-in-2" });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(second);
    const pendingFirst = openNotificationResponse(first);
    const pendingSecond = openNotificationResponse(second);
    releases[0]?.("token");
    releases[1]?.("token");
    await expect(pendingFirst).resolves.toBe(true);
    await expect(pendingSecond).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(2);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("opens one shared-identifier delivery only once", async () => {
    vi.mocked(loadSessionToken).mockResolvedValue("token");
    const data = { botId: "bot-1", threadId: "thread-1", deliveryId: "delivery-once" };
    await expect(openNotificationResponse(tap("thread-shared-once", data))).resolves.toBe(true);
    await expect(openNotificationResponse(tap("thread-shared-once", data))).resolves.toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});
