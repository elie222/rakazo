import { deferred } from "@rakazo/core/test-async";
import { beforeEach, expect, it, vi } from "vitest";
import type { InboxItem } from "./inbox-spaces";

const state = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
  space: "space-a",
  scope: true,
  rpc: vi.fn(),
}));
vi.mock("../api/api", () => ({ selectedSpaceId: () => state.space }));
vi.mock("./chat-rpc", () => ({
  chatRpc: (spaceId: string | undefined, path: string, input: object) =>
    state.rpc(path, input, spaceId),
}));
vi.mock("../api/verified-scope", () => ({
  isVerifiedScopeCurrent: (scope: { selectionId: string }) => scope.selectionId === state.space,
}));
vi.mock("./saved-chats", () => ({
  currentSavedChatsScope: () => null,
  savedChatsScope: async () =>
    state.scope ? { namespace: "ns", selectionId: state.space, spaceId: state.space } : null,
  savedChatTarget: ({ botId, groupId }: { botId?: string; groupId?: string }) =>
    groupId ? `group:${groupId}` : `bot:${botId}`,
  readSavedThread: (scope: { spaceId: string }, target: string) =>
    state.saved.get(`${scope.spaceId}/${target}`) ?? null,
  writeSavedThread: (scope: { spaceId: string }, target: string, snapshot: unknown) => {
    state.saved.set(`${scope.spaceId}/${target}`, snapshot);
  },
}));

const { inboxChats, preloadChats, PRELOADED_CHATS } = await import("./preload-chats");
const { notifyConversationCleared } = await import("../thread/conversation-cleared");

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

  expect(state.rpc.mock.calls.map(([, input]) => input)).toEqual(
    chats.slice(0, PRELOADED_CHATS).filter(({ botId }) => botId !== "b2"),
  );
  expect(state.saved.get(`${state.space}/bot:b2`)).toEqual({ kept: true });
  expect(state.saved.get(`${state.space}/bot:b1`)).toEqual(snapshotOf({ botId: "b1" }));
  expect(state.saved.has(`${state.space}/bot:b${PRELOADED_CHATS + 1}`)).toBe(false);
});

it("asks for each chat once per Space, and again after a failed request", async () => {
  state.rpc.mockRejectedValueOnce(new TypeError("Network request failed"));
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

it("lists every Space's chats in inbox order, pinned ones first", () => {
  const items = [
    { type: "pinned", chats: [{ kind: "group", group: { id: "g1", spaceId: "s1" } }] },
    { type: "heading", key: "h", title: "Bots" },
    { type: "bot", bot: { id: "b1" } },
    { type: "bot", bot: { id: "b2", spaceId: "s2" } },
    { type: "group", group: { id: "g2", spaceId: "s2" } },
  ] as unknown as InboxItem[];
  expect(inboxChats(items)).toEqual([
    { groupId: "g1", spaceId: "s1" },
    { botId: "b1", spaceId: undefined },
    { botId: "b2", spaceId: "s2" },
    { groupId: "g2", spaceId: "s2" },
  ]);
});

it("saves another Space's chat under that Space, asking that Space for it", async () => {
  await preloadChats([{ botId: "b1" }, { botId: "b2", spaceId: "space-other" }]);
  expect(state.rpc.mock.calls).toEqual([
    ["threads/get", { botId: "b1" }, undefined],
    ["threads/get", { botId: "b2" }, "space-other"],
  ]);
  expect(state.saved.get(`${state.space}/bot:b1`)).toEqual(snapshotOf({ botId: "b1" }));
  expect(state.saved.get("space-other/bot:b2")).toEqual(snapshotOf({ botId: "b2" }));
  expect(state.saved.has(`${state.space}/bot:b2`)).toBe(false);
});

it("skips another Space's chat that already has a copy there", async () => {
  state.saved.set("space-other/bot:b2", { kept: true });
  await preloadChats([{ botId: "b2", spaceId: "space-other" }]);
  expect(state.rpc).not.toHaveBeenCalled();
});

it("stops when the Space changes, and never asks for one Space's chats in another", async () => {
  const answer = deferred<unknown>();
  state.rpc.mockImplementationOnce(() => answer.promise);
  const first = state.space;
  const pass = preloadChats([{ botId: "b1" }, { botId: "b2" }]);
  await vi.waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));
  state.space = "space-other";
  // Queued while the first pass is out, under the Space it was listed in.
  const queued = preloadChats([{ botId: "b3" }]);
  state.space = "space-new";
  answer.resolve(snapshotOf({ botId: "b1" }));
  await pass;
  await queued;
  expect(state.rpc).toHaveBeenCalledTimes(1);
  expect(state.saved.has(`${first}/bot:b2`)).toBe(false);
});

it("does not save a chat that was cleared while its request was out", async () => {
  const answer = deferred<unknown>();
  state.rpc.mockImplementationOnce(() => answer.promise);
  const pass = preloadChats([{ botId: "b1" }]);
  await vi.waitFor(() => expect(state.rpc).toHaveBeenCalled());
  notifyConversationCleared("b1");
  answer.resolve(snapshotOf({ botId: "b1" }));
  await pass;
  expect(state.saved.has(`${state.space}/bot:b1`)).toBe(false);
});

it("passes on a refusal, so it is reported", async () => {
  state.rpc.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
  await expect(preloadChats([{ botId: "b1" }])).rejects.toThrow("Forbidden");
  await preloadChats([{ botId: "b1" }]);
  expect(state.rpc).toHaveBeenCalledTimes(1);
});
