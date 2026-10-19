import { expect, it, vi } from "vitest";
import { archivedChatCounts, loadArchivedChats } from "./archived-chats";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc }));

it("keeps the archived bots when the groups list fails", async () => {
  const failure = new Error("Not found");
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "bots/listArchived") return [{ id: "b" }];
    throw failure;
  });
  const signal = new AbortController().signal;
  const loaded = await loadArchivedChats(signal);
  expect(loaded.bots).toEqual([{ id: "b" }]);
  expect(loaded.groups).toBeNull();
  expect(loaded.error).toBe(failure);
  expect(rpc).toHaveBeenCalledWith("bots/listArchived", {}, { signal });
  expect(rpc).toHaveBeenCalledWith("groups/listArchived", {}, { signal });
});

it("keeps the archived groups when the bots list fails", async () => {
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "groups/listArchived") return [{ id: "g" }];
    throw new Error("offline");
  });
  const loaded = await loadArchivedChats();
  expect(loaded.bots).toBeNull();
  expect(loaded.groups).toEqual([{ id: "g" }]);
  expect((loaded.error as Error).message).toBe("offline");
});

it("keeps a list's last count when its refresh fails", () => {
  const previous = { bots: 2, groups: 1 };
  expect(archivedChatCounts(previous, { bots: null, groups: [] })).toEqual({ bots: 2, groups: 0 });
  expect(archivedChatCounts(previous, { bots: [1], groups: null })).toEqual({ bots: 1, groups: 1 });
  expect(archivedChatCounts({ bots: 0, groups: 0 }, { bots: null, groups: null })).toEqual({
    bots: 0,
    groups: 0,
  });
});
