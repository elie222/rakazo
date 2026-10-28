import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountRpcQuery, queryClient, rpcQuery } from "./query";

const scope = vi.hoisted(() => ({
  apiBase: "https://app.example.test",
  generation: 1,
  spaceId: "space-a" as string | null,
  rpc: vi.fn(),
}));
vi.mock("./api", () => ({
  currentApiBase: () => scope.apiBase,
  selectedSpaceId: () => scope.spaceId,
  captureApiRequestContext: async () => ({ apiBase: scope.apiBase, headers: {} }),
  rpc: scope.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => scope.generation }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
});
