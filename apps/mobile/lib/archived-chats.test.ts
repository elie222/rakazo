import { expect, it, vi } from "vitest";
import { archivedChatCounts, loadAllArchivedChats, loadArchivedChats } from "./archived-chats";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({
  rpc,
  captureApiRequestContext: async () => ({
    apiBase: "https://example.test",
    headers: { authorization: "fixture" },
  }),
}));

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

it("loads the archive across spaces using each space's request context", async () => {
  rpc.mockImplementation(
    async (
      procedure: string,
      _body: unknown,
      options: { requestContext: { headers: Record<string, string> } },
    ) => {
      if (procedure === "spaces/list") return { spaces: [{ id: "a" }, { id: "b" }] };
      const spaceId = options.requestContext.headers["x-rakazo-space-id"];
      if (procedure === "bots/listArchived") return spaceId === "b" ? [{ id: "bot-b" }] : [];
      return spaceId === "a" ? [{ id: "group-a" }] : [];
    },
  );
  const loaded = await loadAllArchivedChats();
  expect(loaded.bots).toEqual([{ id: "bot-b", spaceId: "b" }]);
  expect(loaded.groups).toEqual([{ id: "group-a", spaceId: "a" }]);
  expect(loaded.error).toBeUndefined();
});

it("preserves the previous total for a failed list while refreshing the other across spaces", async () => {
  rpc.mockImplementation(
    async (
      procedure: string,
      _body: unknown,
      options: { requestContext: { headers: Record<string, string> } },
    ) => {
      if (procedure === "spaces/list") return { spaces: [{ id: "a" }, { id: "b" }] };
      if (
        procedure === "bots/listArchived" &&
        options.requestContext.headers["x-rakazo-space-id"] === "b"
      )
        throw new Error("offline");
      return procedure === "groups/listArchived" ? [{ id: "group" }] : [];
    },
  );
  const loaded = await loadAllArchivedChats();
  expect(archivedChatCounts({ bots: 3, groups: 0 }, loaded)).toEqual({ bots: 3, groups: 2 });
  expect(loaded.error).toBeInstanceOf(Error);
});
