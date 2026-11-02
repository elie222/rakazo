import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  addNotificationResponseReceivedListener: vi.fn(),
  clearLastNotificationResponse: vi.fn(),
  getLastNotificationResponse: vi.fn(),
  useLastNotificationResponse: vi.fn(),
}));
vi.mock("expo-router", () => ({
  router: { push: vi.fn(), dismissTo: vi.fn(), replace: vi.fn() },
}));
vi.mock("./account-sessions", () => ({
  selectNotificationAccount: vi.fn(),
}));
vi.mock("./api", () => ({ currentApiBase: () => "https://api.example.test" }));
vi.mock("./settings-sheet", () => ({
  closeSettingsSheet: vi.fn(),
}));

import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { selectNotificationAccount } from "./account-sessions";
import { threadRouteId } from "./notification-open";
import { openNotificationResponse } from "./open-notification";
import { closeSettingsSheet } from "./settings-sheet";

const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";

it("routes an authenticated server alias through the configured API", async () => {
  vi.mocked(selectNotificationAccount).mockResolvedValue(true);
  await openNotificationResponse(
    tap("canonical-alias", {
      userId: "work",
      apiBase: "https://web.example.test",
      botId: "work-bot",
    }),
  );
  expect(selectNotificationAccount).toHaveBeenCalledWith("work", "https://web.example.test");
  expect(router.push).toHaveBeenCalledWith(
    {
      pathname: "/thread",
      params: { userId: "work", apiBase: "https://api.example.test", botId: "work-bot" },
    },
    { dangerouslySingular: threadRouteId },
  );
});

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
  it("ignores an older tap that finishes after a newer account was opened", async () => {
    let finishOlder!: (selected: boolean) => void;
    vi.mocked(selectNotificationAccount)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOlder = resolve;
          }),
      )
      .mockResolvedValueOnce(true);
    const older = openNotificationResponse(
      tap("older-account", { userId: "family", botId: "family-bot" }),
    );
    await expect(
      openNotificationResponse(tap("newer-account", { userId: "work", botId: "work-bot" })),
    ).resolves.toBe(true);
    finishOlder(false);
    await expect(older).resolves.toBe(false);
    expect(router.push).toHaveBeenCalledExactlyOnceWith(
      { pathname: "/thread", params: { userId: "work", botId: "work-bot" } },
      { dangerouslySingular: threadRouteId },
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("closes the settings sheet before opening the thread, so it doesn't open behind it", async () => {
    vi.mocked(selectNotificationAccount).mockResolvedValue(true);

    await expect(openNotificationResponse(tap("tap-over-settings"))).resolves.toBe(true);
    expect(closeSettingsSheet).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeSettingsSheet).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(router.push).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("opens a signed-in tap once when the cold start and the listener both see it", async () => {
    let release: (token: boolean) => void = () => undefined;
    vi.mocked(selectNotificationAccount).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const response = tap("tap-signed-in");
    const first = openNotificationResponse(response);
    const second = openNotificationResponse(response);
    release(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      { pathname: "/thread", params: { botId: "bot-1", threadId: "thread-1" } },
      { dangerouslySingular: threadRouteId },
    );
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  it("drops a signed-out tap so a later cold start cannot replay it", async () => {
    vi.mocked(selectNotificationAccount).mockResolvedValue(false);
    const response = tap("tap-signed-out", {
      botId: "bot-1",
      threadId: "thread-1",
      spaceId: "space-2",
    });
    vi.mocked(Notifications.getLastNotificationResponse).mockReturnValue(response);
    await expect(openNotificationResponse(response)).resolves.toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);

    vi.mocked(selectNotificationAccount).mockResolvedValue(true);
    await expect(openNotificationResponse(response)).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("leaves the last response in place when the tap cannot be opened or the session read fails", async () => {
    vi.mocked(selectNotificationAccount).mockResolvedValue(false);
    await expect(openNotificationResponse(null)).resolves.toBe(false);
    await expect(openNotificationResponse(tap("tap-empty", { kind: "completion" }))).resolves.toBe(
      false,
    );
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    vi.mocked(selectNotificationAccount).mockRejectedValue(new Error("locked"));
    await expect(openNotificationResponse(tap("tap-locked"))).resolves.toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();

    vi.mocked(selectNotificationAccount).mockResolvedValue(true);
    await expect(openNotificationResponse(tap("tap-locked"))).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("leaves a newer last response in place when an older signed-out tap is rejected", async () => {
    let release: (token: boolean) => void = () => undefined;
    vi.mocked(selectNotificationAccount).mockImplementation(
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
    release(false);
    await expect(pending).resolves.toBe(false);
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    vi.mocked(selectNotificationAccount).mockResolvedValue(true);
    await expect(openNotificationResponse(newer)).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      { pathname: "/thread", params: { botId: "bot-2", threadId: "thread-2" } },
      { dangerouslySingular: threadRouteId },
    );
  });

  it("treats two deliveries that share a request identifier as different taps", async () => {
    const releases: Array<(token: boolean) => void> = [];
    vi.mocked(selectNotificationAccount).mockImplementation(
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

    releases[0]?.(false);
    await expect(pendingOlder).resolves.toBe(false);
    expect(Notifications.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    releases[1]?.(true);
    await expect(pendingNewer).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("opens the latest concurrent delivery when request identifiers are shared", async () => {
    const releases: Array<(token: boolean) => void> = [];
    vi.mocked(selectNotificationAccount).mockImplementation(
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
    releases[0]?.(true);
    releases[1]?.(true);
    await expect(pendingFirst).resolves.toBe(false);
    await expect(pendingSecond).resolves.toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("opens one shared-identifier delivery only once", async () => {
    vi.mocked(selectNotificationAccount).mockResolvedValue(true);
    const data = { botId: "bot-1", threadId: "thread-1", deliveryId: "delivery-once" };
    await expect(openNotificationResponse(tap("thread-shared-once", data))).resolves.toBe(true);
    await expect(openNotificationResponse(tap("thread-shared-once", data))).resolves.toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});

it("selects the payload account before opening its chat and refuses unavailable accounts", async () => {
  vi.mocked(selectNotificationAccount).mockResolvedValue(true);
  await expect(
    openNotificationResponse(tap("account-work", { userId: "work", botId: "bot-work" })),
  ).resolves.toBe(true);
  expect(selectNotificationAccount).toHaveBeenCalledWith("work", undefined);
  expect(vi.mocked(selectNotificationAccount).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(router.push).mock.invocationCallOrder[0]!,
  );
  vi.mocked(selectNotificationAccount).mockResolvedValue(false);
  vi.mocked(router.push).mockClear();
  await expect(
    openNotificationResponse(tap("account-removed", { userId: "removed", botId: "bot-removed" })),
  ).resolves.toBe(false);
  expect(router.push).not.toHaveBeenCalled();
});
