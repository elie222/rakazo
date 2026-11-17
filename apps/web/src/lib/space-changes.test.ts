import { QueryClient } from "@tanstack/react-query";
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
    routines: key("routines", "list"),
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
});

it("knows which frames are read changes", () => {
  expect(isReadChangeKind("runs")).toBe(true);
  expect(isReadChangeKind("routines")).toBe(true);
  expect(isReadChangeKind("computerUpdates")).toBe(false);
  expect(isReadChangeKind("toString")).toBe(false);
});
