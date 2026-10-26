// @vitest-environment jsdom

import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MobileBot, MobileGroup, MobileSpace } from "./api";
import { rpc } from "./api";
import { notifyArchivedChatsChanged } from "./archived-chats";
import { confirmDeleteBot, confirmDeleteGroup } from "./bot-lifecycle";
import type { InboxRowAction } from "./inbox-swipe";
import { applyUnreadOverrides, withoutArchiving } from "./inbox-swipe";
import { dismissThreadNotifications } from "./live-notifications";
import { removeFromSearchInbox } from "./search-inbox";
import { useInboxChatActions } from "./use-inbox-chat-actions";

const session = vi.hoisted(() => ({ space: "space-a", generation: 1, alert: vi.fn() }));

vi.mock("react-native", () => ({ Alert: { alert: session.alert } }));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({
    apiBase: "",
    headers: { authorization: "Bearer token", "x-rakazo-space-id": session.space },
    sessionGeneration: session.generation,
  }),
  currentApiBase: () => "",
  loadSessionToken: async () => null,
  rpc: vi.fn(),
  selectedSpaceId: () => session.space,
}));
vi.mock("./archived-chats", () => ({ notifyArchivedChatsChanged: vi.fn() }));
vi.mock("./bot-lifecycle", () => ({ confirmDeleteBot: vi.fn(), confirmDeleteGroup: vi.fn() }));
vi.mock("./confirm-delete-section", () => ({ confirmDeleteSection: vi.fn() }));
vi.mock("./i18n", () => {
  const i18n = { t: (text: string) => text };
  return { useI18n: () => i18n };
});
vi.mock("./live-notifications", () => ({
  afterChatNotifyChange: vi.fn(async () => {}),
  dismissThreadNotifications: vi.fn(async () => {}),
}));
vi.mock("./search-inbox", () => ({ removeFromSearchInbox: vi.fn() }));
vi.mock("./section-name-prompt", () => ({ promptSectionName: vi.fn() }));
vi.mock("./session", () => ({ currentSessionGeneration: () => session.generation }));
vi.mock("./user-error", () => ({ errorText: (_error: unknown, fallback: string) => fallback }));

type Actions = ReturnType<typeof useInboxChatActions>;
type Chat = { id: string; name?: string; spaceId?: string; threadId?: string };

let root: Root | undefined;
const sent = (call: unknown[]) => call.slice(0, 2);

beforeEach(() => {
  session.space = "space-a";
  session.generation = 1;
  vi.clearAllMocks();
});

afterEach(() => {
  root?.unmount();
  root = undefined;
});

async function handlers(
  respond: (procedure: string, input: unknown, options?: unknown) => Promise<unknown>,
) {
  vi.mocked(rpc).mockImplementation(respond as typeof rpc);
  const lists = {
    bots: [{ id: "b1", unread: false }] as MobileBot[],
    groups: [{ id: "g1", unread: true }] as MobileGroup[],
    spaces: [
      { id: "space-a", bots: [{ id: "b1" }], groups: [{ id: "g1" }] },
      { id: "space-b", bots: [{ id: "x" }], groups: [{ id: "x" }] },
    ] as MobileSpace[],
  };
  const update =
    <K extends keyof typeof lists>(key: K) =>
    (next: (typeof lists)[K] | ((current: (typeof lists)[K]) => (typeof lists)[K])) => {
      lists[key] = typeof next === "function" ? next(lists[key]) : next;
    };
  const loadBots = vi.fn<() => Promise<unknown>>(async () => {});
  let actions: Actions | undefined;
  function Harness() {
    actions = useInboxChatActions({
      loadBots,
      setBots: update("bots"),
      setGroups: update("groups"),
      setSpaces: update("spaces"),
      botSections: [],
    });
    return null;
  }
  const container = document.createElement("div");
  root = createRoot(container);
  root.render(<Harness />);
  await vi.waitFor(() => expect(actions).toBeDefined());
  const current = () => actions!;
  return {
    loadBots,
    state: Object.defineProperties(lists, {
      // The hook's own state, as last rendered.
      overrides: { get: () => current().unreadOverrides },
      archiving: { get: () => current().archiving },
    }) as typeof lists & {
      overrides: ReadonlyMap<string, boolean>;
      archiving: ReadonlySet<string>;
    },
    runRowAction: (kind: "bot" | "group", chat: Chat, action: InboxRowAction) =>
      current().runRowAction(kind, chat as MobileBot, action),
    updateChat: (kind: "bot" | "group", chat: Chat, change: { pinned?: boolean }) =>
      current().updateChat(kind, chat as MobileBot, change),
  };
}

it("sends overlapping read changes for one chat in order and keeps the newest on screen", async () => {
  const pending: Array<() => void> = [];
  const h = await handlers(() => new Promise<void>((resolve) => pending.push(resolve)));
  const first = h.runRowAction("bot", { id: "b1" }, "unread");
  const second = h.runRowAction("bot", { id: "b1" }, "read");
  await second;
  // The second change waits for the first instead of racing it.
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  expect(sent(vi.mocked(rpc).mock.calls[0]!)).toEqual(["threads/markUnread", { botId: "b1" }]);
  await vi.waitFor(() => expect(h.state.overrides.get("bot:b1")).toBe(false));
  pending.shift()!();
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  expect(sent(vi.mocked(rpc).mock.calls[1]!)).toEqual(["threads/markRead", { botId: "b1" }]);
  // The first request finishing must not clear the newer choice.
  expect(h.state.overrides.get("bot:b1")).toBe(false);
  pending.shift()!();
  await first;
  expect(h.state.bots[0]!.unread).toBe(false);
  await vi.waitFor(() => expect(h.state.overrides.size).toBe(0));
});

it("clears a chat's delivered notifications when it is marked read, not unread", async () => {
  const h = await handlers(async () => undefined);
  await h.runRowAction("bot", { id: "b1", threadId: "thread-b1" }, "read");
  await h.runRowAction("bot", { id: "b2" }, "read");
  await h.runRowAction("group", { id: "g1" }, "read");
  await h.runRowAction("bot", { id: "b1" }, "unread");
  expect(vi.mocked(dismissThreadNotifications).mock.calls).toEqual([
    [{ threadId: "thread-b1" }],
    [{ botId: "b2" }],
    [{ groupId: "g1" }],
  ]);
});

it("drops a change that is undone before its turn", async () => {
  const pending: Array<() => void> = [];
  const h = await handlers(() => new Promise<void>((resolve) => pending.push(resolve)));
  const first = h.runRowAction("group", { id: "g1" }, "read");
  void h.runRowAction("group", { id: "g1" }, "unread");
  void h.runRowAction("group", { id: "g1" }, "read");
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending.shift()!();
  await first;
  expect(vi.mocked(rpc).mock.calls.map(sent)).toEqual([["threads/markRead", { groupId: "g1" }]]);
  expect(h.state.groups[0]!.unread).toBe(false);
  await vi.waitFor(() => expect(h.state.overrides.size).toBe(0));
});

it("sends a queued change in the Space it was swiped in after a Space switch", async () => {
  const pending: Array<() => void> = [];
  const h = await handlers(() => new Promise<void>((resolve) => pending.push(resolve)));
  const first = h.runRowAction("bot", { id: "b1" }, "unread");
  void h.runRowAction("bot", { id: "b1" }, "read");
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  session.space = "space-b";
  pending.shift()!();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const spaces = vi
    .mocked(rpc)
    .mock.calls.map(
      (call) =>
        (call[2] as { requestContext: { headers: Record<string, string> } }).requestContext.headers[
          "x-rakazo-space-id"
        ],
    );
  expect(spaces).toEqual(["space-a", "space-a"]);
  pending.shift()!();
  await first;
});

it("drops queued changes quietly once the session changes", async () => {
  const pending: Array<() => void> = [];
  const h = await handlers(() => new Promise<void>((resolve) => pending.push(resolve)));
  const first = h.runRowAction("bot", { id: "b1" }, "unread");
  void h.runRowAction("bot", { id: "b1" }, "read");
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  session.generation = 2;
  pending.shift()!();
  await first;
  expect(rpc).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(h.state.overrides.size).toBe(0));
  expect(session.alert).not.toHaveBeenCalled();
});

it("marks unread optimistically, keeps it through the request, then refreshes", async () => {
  let finish!: () => void;
  const h = await handlers(() => new Promise<void>((resolve) => (finish = resolve)));
  const pending = h.runRowAction("bot", { id: "b1" }, "unread");
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  expect(sent(vi.mocked(rpc).mock.calls[0]!)).toEqual(["threads/markUnread", { botId: "b1" }]);
  await vi.waitFor(() => expect(h.state.overrides.get("bot:b1")).toBe(true));
  // A poll landing now still shows the stale server value underneath the override.
  expect(applyUnreadOverrides("bot", h.state.bots, h.state.overrides)[0]!.unread).toBe(true);
  finish();
  await pending;
  expect(h.state.bots[0]!.unread).toBe(true);
  expect(h.loadBots).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(h.state.overrides.size).toBe(0));
  expect(session.alert).not.toHaveBeenCalled();
});

it("rolls a failed read change back and uses the native alert", async () => {
  const h = await handlers(async () => {
    throw new Error("offline");
  });
  await h.runRowAction("group", { id: "g1" }, "read");
  expect(sent(vi.mocked(rpc).mock.calls[0]!)).toEqual(["threads/markRead", { groupId: "g1" }]);
  await vi.waitFor(() => expect(h.state.overrides.size).toBe(0));
  expect(h.state.groups[0]!.unread).toBe(true);
  expect(session.alert).toHaveBeenCalledWith("Could not update chat", "Try again.");
});

it.each([
  ["bot", "archive", "bots/archive", { botId: "x" }],
  ["group", "archive", "groups/archive", { groupId: "x" }],
  ["bot", "pin", "bots/update", { botId: "x", pinned: true }],
  ["group", "unpin", "groups/update", { groupId: "x", pinned: false }],
] as const)("%s %s calls %s and refreshes the inbox", async (kind, action, procedure, input) => {
  const h = await handlers(async () => ({ ok: true }));
  await h.runRowAction(kind, { id: "x" }, action);
  expect(vi.mocked(rpc).mock.calls).toEqual([[procedure, input]]);
  expect(h.loadBots).toHaveBeenCalledTimes(1);
});

it.each([
  ["bot", confirmDeleteBot],
  ["group", confirmDeleteGroup],
] as const)(
  "%s delete asks with the chat's own confirmation and refreshes once deleted",
  async (kind, confirm) => {
    const h = await handlers(async () => ({ ok: true }));
    await h.runRowAction(kind, { id: "x", name: "Ada" }, "delete");
    // Nothing is removed until the alert is confirmed.
    expect(rpc).not.toHaveBeenCalled();
    expect(h.loadBots).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith({ id: "x", name: "Ada" }, expect.any(Function));
    vi.mocked(confirm).mock.calls[0]![1]!();
    expect(h.loadBots).toHaveBeenCalledTimes(1);
  },
);

it("hides an archived chat at the tap and keeps it hidden from a reload until it settles", async () => {
  let finish!: (value: unknown) => void;
  const h = await handlers(() => new Promise((resolve) => (finish = resolve)));
  let finishReload!: () => void;
  const reload = new Promise<void>((resolve) => (finishReload = resolve));
  h.loadBots.mockImplementation(async () => {
    await reload;
    h.state.bots = h.state.bots.filter((bot) => bot.id !== "b1");
  });
  h.state.bots = [
    { id: "b0", unread: false },
    ...h.state.bots,
    { id: "b2", unread: false },
  ] as MobileBot[];
  const polledBots = [...h.state.bots];
  const pending = h.runRowAction("bot", { id: "b1" }, "archive");
  await vi.waitFor(() => expect(h.state.archiving).toEqual(new Set(["bot:b1"])));
  // A poll that still lists the chat doesn't bring the row back while the archive runs.
  expect(withoutArchiving("bot", h.state.bots, h.state.archiving).map((bot) => bot.id)).toEqual([
    "b0",
    "b2",
  ]);
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
  finish({ ok: true });
  await vi.waitFor(() => expect(h.loadBots).toHaveBeenCalledTimes(1));
  expect(h.state.bots.map((bot) => bot.id)).toEqual(["b0", "b2"]);
  // A poll replaces the stored list while the post-archive reload is still pending.
  h.state.bots = polledBots;
  expect(h.state.archiving).toEqual(new Set(["bot:b1"]));
  expect(withoutArchiving("bot", h.state.bots, h.state.archiving).map((bot) => bot.id)).toEqual([
    "b0",
    "b2",
  ]);
  finishReload();
  await pending;
  expect(h.state.bots.map((bot) => bot.id)).toEqual(["b0", "b2"]);
  expect(h.state.spaces[0]!.bots).toEqual([]);
  expect(h.loadBots).toHaveBeenCalledTimes(1);
  expect(notifyArchivedChatsChanged).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(h.state.archiving.size).toBe(0));
  expect(session.alert).not.toHaveBeenCalled();
});

it("keeps an archived chat gone when the reload after the archive fails", async () => {
  const h = await handlers(async () => ({ ok: true }));
  // loadBots reports a failed load by resolving false and leaves the list as it was.
  h.loadBots.mockImplementation(async () => false);
  await h.runRowAction("group", { id: "g1" }, "archive");
  expect(h.state.groups).toEqual([]);
  await vi.waitFor(() => expect(h.state.archiving.size).toBe(0));
});

it("puts a chat back in its place when the archive fails", async () => {
  const h = await handlers(async () => {
    throw new Error("offline");
  });
  h.state.bots = [
    { id: "b0", unread: false },
    ...h.state.bots,
    { id: "b2", unread: false },
  ] as MobileBot[];
  await h.runRowAction("bot", { id: "b1" }, "archive");
  await vi.waitFor(() => expect(h.state.archiving.size).toBe(0));
  expect(withoutArchiving("bot", h.state.bots, h.state.archiving).map((bot) => bot.id)).toEqual([
    "b0",
    "b1",
    "b2",
  ]);
  expect(notifyArchivedChatsChanged).not.toHaveBeenCalled();
  expect(session.alert).toHaveBeenCalledWith("Could not archive bot", "Try again.");
  expect(h.loadBots).toHaveBeenCalledTimes(1);
});

it("archives a chat from another space in that space", async () => {
  const h = await handlers(async () => ({ ok: true }));
  await h.runRowAction("group", { id: "x", spaceId: "space-b" }, "archive");
  expect(vi.mocked(rpc).mock.calls[0]?.[2]).toMatchObject({
    requestContext: { headers: { "x-rakazo-space-id": "space-b" } },
  });
});

it("marks a chat from another space read in that space", async () => {
  const h = await handlers(async () => ({ ok: true }));
  await h.runRowAction("bot", { id: "x", spaceId: "space-b" }, "read");
  expect(vi.mocked(rpc).mock.calls[0]?.[2]).toMatchObject({
    requestContext: { headers: { "x-rakazo-space-id": "space-b" } },
  });
});

it("updates a chat from another space in that space without switching", async () => {
  const h = await handlers(async () => ({ ok: true }));
  await h.updateChat("bot", { id: "x", spaceId: "space-b" }, { pinned: false });
  expect(vi.mocked(rpc).mock.calls).toEqual([
    [
      "bots/update",
      { botId: "x", pinned: false },
      {
        requestContext: {
          apiBase: "",
          headers: { authorization: "Bearer token", "x-rakazo-space-id": "space-b" },
          sessionGeneration: 1,
        },
        skipSpaceAuthRecovery: true,
      },
    ],
  ]);
  expect(h.loadBots).toHaveBeenCalledTimes(1);
});

it("names the archive failure for bots", async () => {
  const h = await handlers(async () => {
    throw new Error("nope");
  });
  await h.runRowAction("bot", { id: "x" }, "archive");
  await h.runRowAction("group", { id: "x" }, "pin");
  expect(session.alert.mock.calls.map(([title]) => title)).toEqual([
    "Could not archive bot",
    "Could not update chat",
  ]);
  expect(notifyArchivedChatsChanged).not.toHaveBeenCalled();
  expect(removeFromSearchInbox).not.toHaveBeenCalled();
});

it.each(["bot", "group"] as const)(
  "updates the archived count once a %s is archived",
  async (kind) => {
    const h = await handlers(async () => ({ ok: true }));
    await h.runRowAction(kind, { id: "x" }, "archive");
    // Search stops offering it at once, before the inbox reloads.
    expect(removeFromSearchInbox).toHaveBeenCalledWith("x");
    expect(notifyArchivedChatsChanged).toHaveBeenCalledOnce();
    await h.runRowAction(kind, { id: "x" }, "pin");
    expect(notifyArchivedChatsChanged).toHaveBeenCalledOnce();
  },
);
