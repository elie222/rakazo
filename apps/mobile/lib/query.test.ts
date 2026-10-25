import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFresh, queryClient, rpcQuery, writeSaved } from "./query";

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
    const read = rpcQuery<string>("voice/status");
    const fetching = queryClient.fetchQuery(read);
    await vi.waitFor(() => expect(scope.rpc).toHaveBeenCalled());
    scope.spaceId = "space-b";
    answer.resolve("space b data");
    await expect(fetching).rejects.toThrow();
    expect(queryClient.getQueryData(read.queryKey)).toBeUndefined();
  });
});

describe("saves", () => {
  it("are not overwritten by a read that started before them", async () => {
    const older = deferred<string>();
    scope.rpc.mockReturnValueOnce(older.promise);
    const read = rpcQuery<string>("voice/status");
    void queryClient.fetchQuery(read).catch(() => undefined);
    await vi.waitFor(() => expect(scope.rpc).toHaveBeenCalledTimes(1));

    await writeSaved(read.queryKey, () => "saved");
    older.resolve("before save");
    await older.promise;
    await Promise.resolve();
    expect(queryClient.getQueryData(read.queryKey)).toBe("saved");
  });

  it("refresh with a request sent after the change, while opening reuses one in flight", async () => {
    const older = deferred<string>();
    scope.rpc.mockReturnValueOnce(older.promise).mockResolvedValueOnce("after change");
    const read = rpcQuery<string>("models/credentials");
    const opening = fetchFresh(read, { reuse: true });
    const sharing = fetchFresh(read, { reuse: true });
    await vi.waitFor(() => expect(scope.rpc).toHaveBeenCalledTimes(1));

    const fresh = await fetchFresh(read);
    older.resolve("before change");
    expect(fresh).toBe("after change");
    expect(scope.rpc).toHaveBeenCalledTimes(2);
    await Promise.allSettled([opening, sharing]);
    expect(queryClient.getQueryData(read.queryKey)).toBe("after change");
  });
});
