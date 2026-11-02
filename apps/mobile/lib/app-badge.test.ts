import { beforeEach, describe, expect, it, vi } from "vitest";

const accountDisk = vi.hoisted(() => new Map<string, string>());
const refreshSummary = vi.hoisted(() => vi.fn(async (_userId?: string) => []));
vi.mock("./account-sessions", () => ({ refreshAccountSummaries: refreshSummary }));
vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(async (key: string) => {
    accountDisk.delete(key);
  }),
  getItemAsync: vi.fn(async (key: string) => accountDisk.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    accountDisk.set(key, value);
  }),
}));

vi.mock("expo-notifications", () => ({ setBadgeCountAsync: vi.fn(async () => true) }));

import * as Notifications from "expo-notifications";

async function load() {
  vi.resetModules();
  return import("./app-badge");
}

beforeEach(() => {
  vi.mocked(Notifications.setBadgeCountAsync).mockReset().mockResolvedValue(true);
  refreshSummary.mockReset().mockResolvedValue([]);
  accountDisk.clear();
});

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

it("keeps inactive-account unread counts when the selected inbox updates", async () => {
  accountDisk.clear();
  const badge = await load();
  const accounts = await import("./saved-accounts");
  const apiBase = "https://app.example.test";
  await accounts.rememberSavedAccount(apiBase, {
    userId: "family",
    token: "family-token",
    name: "Family",
    email: "family@example.test",
    image: null,
    unread: 2,
  });
  await accounts.rememberSavedAccount(apiBase, {
    userId: "work",
    token: "work-token",
    name: "Work",
    email: "work@example.test",
    image: null,
    unread: 5,
  });
  accounts.setSelectedSavedAccount({ apiBase, userId: "family" });
  refreshSummary.mockImplementation(async () => {
    await accounts.updateSavedAccountIfCurrent(apiBase, "family-token", (row) => ({
      ...row,
      unread: 3,
    }));
    return [];
  });
  await badge.syncInboxAppBadge(3, badge.appBadgeGeneration());
  expect(Notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(8);
});

it("preserves other organizations when the selected inbox changes across two saved accounts", async () => {
  const badge = await load();
  const accounts = await import("./saved-accounts");
  const apiBase = "https://app.example.test";
  const organizations = { personal: 2, shared: 4 };
  for (const [userId, unread] of [
    ["family", 6],
    ["work", 5],
  ] as const)
    await accounts.rememberSavedAccount(apiBase, {
      userId,
      token: `${userId}-token`,
      name: userId,
      email: `${userId}@example.test`,
      image: null,
      unread,
    });
  accounts.setSelectedSavedAccount({ apiBase, userId: "family" });
  refreshSummary.mockImplementation(async (userId) => {
    expect(userId).toBe("family");
    await accounts.updateSavedAccountIfCurrent(apiBase, "family-token", (row) => ({
      ...row,
      unread: organizations.personal + organizations.shared,
    }));
    return [];
  });
  await badge.syncInboxAppBadge(organizations.personal, badge.appBadgeGeneration());
  expect(Notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(11);
  organizations.personal = 1;
  await badge.syncInboxAppBadge(organizations.personal, badge.appBadgeGeneration());
  expect(Notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(10);
  expect(accounts.cachedSavedAccounts(apiBase).map((row) => [row.userId, row.unread])).toEqual([
    ["family", 5],
    ["work", 5],
  ]);
});

it.each(["account", "foreground", "token"])(
  "does not publish a late summary after the %s changes",
  async (change) => {
    const badge = await load();
    const accounts = await import("./saved-accounts");
    const apiBase = "https://app.example.test";
    await accounts.rememberSavedAccount(apiBase, {
      userId: "family",
      token: "family-token",
      name: "Family",
      email: "family@example.test",
      image: null,
      unread: 6,
    });
    accounts.setSelectedSavedAccount({ apiBase, userId: "family" });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshSummary.mockImplementation(async () => {
      await waiting;
      return [];
    });
    const pending = badge.syncInboxAppBadge(2, badge.appBadgeGeneration());
    await vi.waitFor(() => expect(refreshSummary).toHaveBeenCalledWith("family"));
    if (change === "account") accounts.setSelectedSavedAccount({ apiBase, userId: "work" });
    else if (change === "foreground") badge.forgetAppBadge();
    else await accounts.replaceSavedToken(apiBase, "family-token", "replacement-token");
    release();
    await pending;
    expect(Notifications.setBadgeCountAsync).not.toHaveBeenCalled();
  },
);
