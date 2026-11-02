import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-notifications", () => ({ setBadgeCountAsync: vi.fn(async () => true) }));

import * as Notifications from "expo-notifications";

async function load() {
  vi.resetModules();
  return import("./app-badge");
}

beforeEach(() => vi.mocked(Notifications.setBadgeCountAsync).mockReset().mockResolvedValue(true));

describe("app icon badge", () => {
  it("counts unread chats, bots and groups, across every Space", async () => {
    const { unreadChatCount } = await load();
    expect(
      unreadChatCount([
        { bots: [{ unread: true }, { unread: false }], groups: [{ unread: true }] },
        { bots: [{ unread: true }], groups: [] },
      ]),
    ).toBe(3);
    expect(unreadChatCount([])).toBe(0);
  });

  it("writes only when the count changes and retries after a failed write", async () => {
    const { syncAppBadge } = await load();
    await syncAppBadge(2);
    await syncAppBadge(2);
    expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[2]]);
    vi.mocked(Notifications.setBadgeCountAsync).mockResolvedValueOnce(false);
    await syncAppBadge(0);
    await syncAppBadge(0);
    expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[2], [0], [0]]);
  });

  it("writes the same count again once a push may have changed the icon", async () => {
    const { forgetAppBadge, syncAppBadge } = await load();
    await syncAppBadge(2);
    // A background push set the icon to 1; back in the app the inbox still counts 2.
    forgetAppBadge();
    await syncAppBadge(2);
    expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[2], [2]]);
  });
});
