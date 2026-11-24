import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

vi.mock("./query", () => ({ queryClient: new QueryClient() }));

import { isReadChangeKind, spaceChanged } from "./space-changes";

const key = (...procedure: string[]) => [
  ["user:user-1", "space:space-1", ...procedure],
  { type: "query" },
];

it("marks only the reads a change kind covers as stale", async () => {
  const client = new QueryClient();
  const keys = {
    runs: key("runs", "list"),
    history: key("routines", "history"),
    usage: key("usage", "breakdown"),
    topics: key("threads", "topics"),
    routines: key("routines", "list"),
    bots: key("bots", "list"),
  };
  for (const queryKey of Object.values(keys)) client.setQueryData(queryKey, []);
  const invalidated = () =>
    Object.entries(keys)
      .filter(([, queryKey]) => client.getQueryState(queryKey)?.isInvalidated)
      .map(([name]) => name);

  await spaceChanged("runs", client);
  expect(invalidated()).toEqual(["runs", "history", "usage", "topics"]);
  await spaceChanged("routines", client);
  expect(invalidated()).toEqual(["runs", "history", "usage", "topics", "routines"]);
});

it("knows which frames are read changes", () => {
  expect(isReadChangeKind("runs")).toBe(true);
  expect(isReadChangeKind("routines")).toBe(true);
  expect(isReadChangeKind("computerUpdates")).toBe(false);
  expect(isReadChangeKind("toString")).toBe(false);
});

it("re-reads a completed run when its signal arrives during the first Activity read", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = deferred<string[]>();
  const read = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(["completed"]);
  const queryKey = key("runs", "list");
  const observer = new QueryObserver(client, { queryKey, queryFn: read });
  const stop = observer.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const changed = spaceChanged("runs", client);
    first.resolve(["running"]);
    await changed;
    await vi.waitFor(() => expect(client.getQueryData(queryKey)).toEqual(["completed"]));
  } finally {
    stop();
    client.clear();
  }
});

it("keeps a saved page edit when cancelling an older read and the refresh fails", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = deferred<{ title: string }>();
  const read = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockRejectedValue(new Error("offline"));
  const queryKey = key("pages", "get");
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: read,
    initialData: { title: "Before" },
  });
  const stop = observer.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    client.setQueriesData({ queryKey }, { title: "Saved edit" });
    const changed = spaceChanged("pages", client);
    first.resolve({ title: "Before" });
    await changed;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(client.getQueryData(queryKey)).toEqual({ title: "Saved edit" });
  } finally {
    stop();
    client.clear();
  }
});

it("does not cancel an unobserved routine read owned by chat synchronization", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = deferred<string[]>();
  const read = client.fetchQuery({
    queryKey: key("routines", "list"),
    queryFn: () => first.promise,
  });
  const result = read.then(
    (data) => ({ data }),
    (error: unknown) => ({ error }),
  );
  await spaceChanged("routines", client);
  first.resolve(["updated routine"]);
  expect(await result).toEqual({ data: ["updated routine"] });
  client.clear();
});
