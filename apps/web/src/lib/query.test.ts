import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => {
  // Any procedure path, as the real client exposes; these tests never call one.
  const client = (): unknown => new Proxy(() => undefined, { get: () => client() });
  return {
    rpc: client(),
    createSpaceRpc: client,
    rpcForSpace: client,
    selectedSpaceId: () => null,
  };
});

import { queryClient, setQueryUser, spaceQueries } from "./query";

afterEach(() => {
  queryClient.clear();
});

describe("query scopes", () => {
  it("keeps every user and space in its own keys", () => {
    const keys = [
      spaceQueries("user-a", "space-a"),
      spaceQueries("user-a", "space-b"),
      spaceQueries("user-b", "space-a"),
      spaceQueries("user-a", null),
    ].map((scope) => JSON.stringify(scope.bootstrap.queryKey({ input: {} })));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never serves one space's cached data to another", () => {
    queryClient.setQueryData(spaceQueries("user-a", "space-a").voice.status.queryKey(), {
      ready: true,
    } as never);
    expect(
      queryClient.getQueryData(spaceQueries("user-a", "space-b").voice.status.queryKey()),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(spaceQueries("user-b", "space-a").voice.status.queryKey()),
    ).toBeUndefined();
  });

  it("forgets the cache when a different user signs in or everyone signs out", () => {
    const key = spaceQueries("user-a", "space-a").voice.status.queryKey();
    setQueryUser("user-a");
    queryClient.setQueryData(key, { ready: true } as never);
    setQueryUser("user-a");
    expect(queryClient.getQueryData(key)).toBeDefined();
    setQueryUser(null);
    expect(queryClient.getQueryData(key)).toBeUndefined();
    queryClient.setQueryData(key, { ready: true } as never);
    setQueryUser("user-b");
    expect(queryClient.getQueryData(key)).toBeUndefined();
  });
});
