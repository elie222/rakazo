import { deferred } from "@rakazo/core/test-async";
import { beforeEach, expect, it, vi } from "vitest";
import type { InboxItem } from "./inbox-spaces";

const state = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
  space: "space-a",
  scope: true,
  rpc: vi.fn(),
}));
vi.mock("../api/api", () => ({ rpc: state.rpc }));
vi.mock("./saved-chats", () => ({
  currentSavedChatsScope: () => null,
  savedChatsScope: async () =>
    state.scope ? { namespace: "ns", selectionId: state.space, spaceId: state.space } : null,
  savedChatTarget: ({ botId, groupId }: { botId?: string; groupId?: string }) =>
    groupId ? `group:${groupId}` : `bot:${botId}`,
  readSavedThread: (scope: { selectionId: string }, target: string) =>
    state.saved.get(`${scope.selectionId}/${target}`) ?? null,
  writeSavedThread: (scope: { selectionId: string }, target: string, snapshot: unknown) => {
    state.saved.set(`${scope.selectionId}/${target}`, snapshot);
  },
}));

const { inboxChats, preloadChats, PRELOADED_CHATS } = await import("./preload-chats");

const snapshotOf = (input: { botId?: string; groupId?: string }) => ({ fetched: input });

beforeEach(() => {
  state.saved.clear();
  state.scope = true;
  state.space = `space-${Math.random()}`;
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (_path: string, input: object) => snapshotOf(input));
});

it("saves a copy of the first chats that have none, one request at a time", async () => {
  state.saved.set(`${state.space}/bot:b2`, { kept: true });
  const chats = Array.from({ length: PRELOADED_CHATS + 2 }, (_, index) => ({
    botId: `b${index + 1}`,
  }));
  const first = deferred<unknown>();
  state.rpc.mockImplementationOnce(() => first.promise);
  const pass = preloadChats(chats);
  await vi.waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));
  first.resolve(snapshotOf({ botId: "b1" }));
  await pass;

  expect(state.rpc.mock.calls.map(([, input]) => input)).toEqual([
    { botId: "b1" },
    { botId: "b3" },
    { botId: "b4" },
    { botId: "b5" },
  ]);
  expect(state.saved.get(`${state.space}/bot:b2`)).toEqual({ kept: true });
  expect(state.saved.get(`${state.space}/bot:b1`)).toEqual(snapshotOf({ botId: "b1" }));
  expect(state.saved.has(`${state.space}/bot:b6`)).toBe(false);
});

it("asks for each chat once per Space, and again after a failed request", async () => {
  state.rpc.mockRejectedValueOnce(new Error("offline"));
  await preloadChats([{ botId: "b1" }, { groupId: "g1" }]);
  // The pass stops at the first failure.
  expect(state.rpc).toHaveBeenCalledTimes(1);

  await preloadChats([{ botId: "b1" }, { groupId: "g1" }]);
  await preloadChats([{ botId: "b1" }, { groupId: "g1" }]);
  expect(state.rpc.mock.calls.map(([, input]) => input)).toEqual([
    { botId: "b1" },
    { botId: "b1" },
    { groupId: "g1" },
  ]);
});

it("keeps the copy the chat screen saved while the request was out", async () => {
  const answer = deferred<unknown>();
  state.rpc.mockImplementationOnce(() => answer.promise);
  const pass = preloadChats([{ botId: "b1" }]);
  await vi.waitFor(() => expect(state.rpc).toHaveBeenCalled());
  state.saved.set(`${state.space}/bot:b1`, { opened: true });
  answer.resolve(snapshotOf({ botId: "b1" }));
  await pass;
  expect(state.saved.get(`${state.space}/bot:b1`)).toEqual({ opened: true });
});

it("does nothing without a saved-chat scope", async () => {
  state.scope = false;
  await preloadChats([{ botId: "b1" }]);
  expect(state.rpc).not.toHaveBeenCalled();
});

it("lists the selected Space's chats in inbox order, pinned ones first", () => {
  const items = [
    { type: "pinned", chats: [{ kind: "group", group: { id: "g1" } }] },
    { type: "heading", key: "h", title: "Bots" },
    { type: "bot", bot: { id: "b1" } },
    { type: "bot", bot: { id: "elsewhere" } },
    { type: "group", group: { id: "g2" } },
  ] as unknown as InboxItem[];
  expect(inboxChats(items, { bots: [{ id: "b1" }], groups: [{ id: "g1" }, { id: "g2" }] })).toEqual(
    [{ groupId: "g1" }, { botId: "b1" }, { groupId: "g2" }],
  );
});
