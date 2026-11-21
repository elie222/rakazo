import { deferred, flush } from "@rakazo/core/test-async";
import { QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountRpcQuery, formRead, queryClient, resetRpcQueries, rpcQuery } from "./query";

const scope = vi.hoisted(() => ({
  apiBase: "https://app.example.test",
  generation: 1,
  spaceId: "space-a" as string | null,
  rpc: vi.fn(),
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => scope.apiBase,
  selectedSpaceId: () => scope.spaceId,
  captureApiRequestContext: async (spaceId?: string) => ({
    apiBase: scope.apiBase,
    headers: spaceId ? { space: spaceId } : {},
  }),
  rpc: scope.rpc,
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => scope.generation }));

beforeEach(() => {
  queryClient.clear();
  scope.apiBase = "https://app.example.test";
  scope.generation = 1;
  scope.spaceId = "space-a";
  scope.rpc.mockReset();
});

describe("rpcQuery keys", () => {
  it("separate sessions, spaces, and servers", () => {
    const key = () => JSON.stringify(rpcQuery("voice/status").queryKey);
    const first = key();
    expect(key()).toBe(first);
    scope.spaceId = "space-b";
    const otherSpace = key();
    scope.generation = 2;
    const otherSession = key();
    scope.apiBase = "https://other.example.test";
    const otherServer = key();
    expect(new Set([first, otherSpace, otherSession, otherServer]).size).toBe(4);
    expect(JSON.stringify(rpcQuery("voice/voices", { provider: "a" }).queryKey)).not.toBe(
      JSON.stringify(rpcQuery("voice/voices", { provider: "b" }).queryKey),
    );
  });

  it("does not cache an answer under the space it was asked for after a switch", async () => {
    const answer = deferred<string>();
    scope.rpc.mockReturnValue(answer.promise);
    const read = rpcQuery("voice/status");
    const fetching = queryClient.fetchQuery(read);
    await vi.waitFor(() => expect(scope.rpc).toHaveBeenCalled());
    scope.spaceId = "space-b";
    answer.resolve("space b data");
    await expect(fetching).rejects.toThrow();
    expect(queryClient.getQueryData(read.queryKey)).toBeUndefined();
  });

  it("keep the user's own reads under one key in every space, per session and server", () => {
    const key = () => JSON.stringify(accountRpcQuery("trustedLinkSites/list").queryKey);
    const first = key();
    scope.spaceId = "space-b";
    expect(key()).toBe(first);
    scope.spaceId = null;
    expect(key()).toBe(first);
    scope.generation = 2;
    const otherSession = key();
    scope.apiBase = "https://other.example.test";
    expect(new Set([first, otherSession, key()]).size).toBe(3);
  });

  it("invalidates newest and older comments for just the changed Page", async () => {
    const pageId = "page-a";
    const newest = accountRpcQuery("pageReviews/comments", { pageId, cursor: undefined });
    const older = accountRpcQuery("pageReviews/comments", { pageId, cursor: "older" });
    const other = accountRpcQuery("pageReviews/comments", { pageId: "page-b", cursor: "older" });
    const changed = accountRpcQuery("pageReviews/comments", { pageId });
    for (const read of [newest, older, other])
      queryClient.setQueryData(read.queryKey, { items: [], nextCursor: null });

    await queryClient.invalidateQueries({ queryKey: changed.queryKey });

    expect(queryClient.getQueryState(newest.queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(older.queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(other.queryKey)?.isInvalidated).toBe(false);
  });
});

describe("resetRpcQueries", () => {
  it("forgets a procedure's answers in every space and for every input, and nothing else", async () => {
    const selected = rpcQuery("aiConsent/status");
    const named = rpcQuery("aiConsent/status", { uses: ["voice"] }, "space-b");
    const other = rpcQuery("voice/status");
    for (const read of [selected, named, other])
      queryClient.setQueryData(read.queryKey, "kept" as never);

    await resetRpcQueries("aiConsent/status");
    expect(queryClient.getQueryData(selected.queryKey)).toBeUndefined();
    expect(queryClient.getQueryData(named.queryKey)).toBeUndefined();
    expect(queryClient.getQueryData(other.queryKey)).toBe("kept");
  });
});

describe("formRead", () => {
  it("is sent again on every visit, and never shows a copy from before it", async () => {
    scope.rpc.mockResolvedValueOnce("first visit").mockResolvedValue("second visit");
    const shared = rpcQuery("voice/status");
    // Another screen reading the same data keeps its copy for half an hour.
    queryClient.setQueryData(shared.queryKey, "another screen's copy" as never);
    const visit = async () => {
      const observer = new QueryObserver(queryClient, formRead(rpcQuery("voice/status")));
      const leave = observer.subscribe(() => undefined);
      const opened = observer.getCurrentResult().data;
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
      const read = observer.getCurrentResult().data;
      leave();
      await flush();
      return { opened, read };
    };

    expect(await visit()).toEqual({ opened: undefined, read: "first visit" });
    expect(await visit()).toEqual({ opened: undefined, read: "second visit" });
    expect(queryClient.getQueryData(shared.queryKey)).toBe("another screen's copy");
  });
});
