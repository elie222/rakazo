import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAppBadge, syncAppBadge, unreadChatCount } from "./app-badge";

vi.mock("expo-notifications", () => ({ setBadgeCountAsync: vi.fn(async () => true) }));

import * as Notifications from "expo-notifications";

beforeEach(() => {
  forgetAppBadge();
  vi.mocked(Notifications.setBadgeCountAsync).mockReset().mockResolvedValue(true);
});

describe("app icon badge", () => {
  it("counts unread chats, bots and groups, across every Space", () => {
    expect(
      unreadChatCount([
        { bots: [{ unread: true }, { unread: false }], groups: [{ unread: true }] },
        { bots: [{ unread: true }], groups: [] },
      ]),
    ).toBe(3);
    expect(unreadChatCount([])).toBe(0);
  });

  it("writes only when the count changes and retries after a failed write", async () => {
    await syncAppBadge(2);
    await syncAppBadge(2);
    expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[2]]);
    vi.mocked(Notifications.setBadgeCountAsync).mockResolvedValueOnce(false);
    await syncAppBadge(0);
    await syncAppBadge(0);
    expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[2], [0], [0]]);
  });

  it("writes the same count again once a push may have changed the icon", async () => {
    await syncAppBadge(2);
    // A background push set the icon to 1; back in the app the inbox still counts 2.
    forgetAppBadge();
    await syncAppBadge(2);
    expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[2], [2]]);
  });

  it("finishes native writes in order so a late older count cannot replace the newest", async () => {
    let releaseOlder!: (success: boolean) => void;
    let releaseNewer!: (success: boolean) => void;
    const olderWrite = new Promise<boolean>((resolve) => {
      releaseOlder = resolve;
    });
    const newerWrite = new Promise<boolean>((resolve) => {
      releaseNewer = resolve;
    });
    let icon = 0;
    vi.mocked(Notifications.setBadgeCountAsync)
      .mockImplementationOnce((count) =>
        olderWrite.then(() => {
          icon = count;
          return true;
        }),
      )
      .mockImplementationOnce((count) =>
        newerWrite.then(() => {
          icon = count;
          return true;
        }),
      );
    const older = syncAppBadge(2);
    const newer = syncAppBadge(5);
    try {
      await Promise.resolve();
      expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[2]]);
      releaseOlder(true);
      await older;
      await vi.waitFor(() => expect(Notifications.setBadgeCountAsync).toHaveBeenCalledTimes(2));
      releaseNewer(true);
      await newer;
      expect(icon).toBe(5);
      await syncAppBadge(5);
      expect(Notifications.setBadgeCountAsync).toHaveBeenCalledTimes(2);
    } finally {
      releaseOlder(true);
      releaseNewer(true);
      await Promise.all([older, newer]);
    }
  });

  it("skips queued counts from before a push and rewrites the current generation's count", async () => {
    let release!: (success: boolean) => void;
    vi.mocked(Notifications.setBadgeCountAsync).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const older = syncAppBadge(2);
    await Promise.resolve();
    const stale = syncAppBadge(4);
    forgetAppBadge();
    const current = syncAppBadge(2);
    release(true);
    await Promise.all([older, stale, current]);
    expect(vi.mocked(Notifications.setBadgeCountAsync).mock.calls).toEqual([[2], [2]]);
  });
});
