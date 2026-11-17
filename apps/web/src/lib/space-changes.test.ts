import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

vi.mock("./query", async (importActual) => ({
  ...(await importActual<typeof Query>()),
  queryClient: new QueryClient(),
}));

import type * as Query from "./query";
import { spaceQueries } from "./query";
import { isReadChangeKind, spaceChanged } from "./space-changes";

const queries = spaceQueries("user-1", "space-1");

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
    routines: key("routines", "list"),
    pages: key("pages", "list"),
    page: key("pages", "get"),
    pinned: queries.pages.get.queryKey({ input: { pageId: "p1", version: 3 } }),
    bots: key("bots", "list"),
  };
  for (const queryKey of Object.values(keys)) client.setQueryData(queryKey, []);
  const invalidated = () =>
    Object.entries(keys)
      .filter(([, queryKey]) => client.getQueryState(queryKey)?.isInvalidated)
      .map(([name]) => name);

  await spaceChanged("runs", client);
  expect(invalidated()).toEqual(["runs", "history", "usage"]);
  await spaceChanged("routines", client);
  expect(invalidated()).toEqual(["runs", "history", "usage", "routines"]);
  await spaceChanged("pages", client);
  expect(invalidated()).toEqual(["runs", "history", "usage", "routines", "pages", "page"]);
  // A saved version's code never changes, so a page change leaves its read alone.
  expect(client.getQueryState(keys.pinned)?.isInvalidated).toBe(false);
});

it("knows which frames are read changes", () => {
  expect(isReadChangeKind("runs")).toBe(true);
  expect(isReadChangeKind("routines")).toBe(true);
  expect(isReadChangeKind("pages")).toBe(true);
  expect(isReadChangeKind("computerUpdates")).toBe(false);
  expect(isReadChangeKind("toString")).toBe(false);
});
