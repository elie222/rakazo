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

it("waits for a fresh inbox after foreground and ignores old requests", async () => {
  const badge = await load();
  const before = badge.appBadgeGeneration();
  await badge.syncInboxAppBadge(2, before);
  badge.forgetAppBadge();
  await badge.syncInboxAppBadge(0, before);
  expect(Notifications.setBadgeCountAsync).toHaveBeenCalledTimes(1);
  await badge.syncInboxAppBadge(2, badge.appBadgeGeneration());
  expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[2], [2]]);
});
it("clears a session badge even if the cached count is zero", async () => {
  const badge = await load();
  await badge.syncAppBadge(0);
  const old = badge.appBadgeGeneration();
  await badge.clearAppBadge();
  await badge.syncInboxAppBadge(3, old);
  expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[0], [0]]);
});

it("does not write before a live inbox has loaded", async () => {
  const badge = await load();
  await badge.syncInboxAppBadge(0, null);
  expect(Notifications.setBadgeCountAsync).not.toHaveBeenCalled();
});
