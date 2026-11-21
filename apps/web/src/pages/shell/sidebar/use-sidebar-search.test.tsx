// @vitest-environment jsdom
import type { SearchHit } from "@rakazo/contracts";
import { SEARCH_QUERY_MAX_LENGTH } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidebarSearch } from "./use-sidebar-search";
import { useSidebarSearch } from "./use-sidebar-search";

type Request = {
  q: string;
  signal: AbortSignal;
  resolve: (hits: SearchHit[]) => void;
  reject: (error: unknown) => void;
};

const hit = (title: string): SearchHit => ({
  kind: "conversation",
  botId: "bot-1",
  title,
  snippet: "",
});

let requests: Request[];
let root: Root;
let latest: SidebarSearch;

const rpc = {
  search: {
    query: ({ q }: { q: string }, { signal }: { signal: AbortSignal }) =>
      new Promise<{ hits: SearchHit[] }>((resolve, reject) => {
        requests.push({ q, signal, resolve: (hits) => resolve({ hits }), reject });
      }),
  },
} as unknown as Parameters<typeof useSidebarSearch>[0]["rpc"];

function Harness() {
  latest = useSidebarSearch({ rpc, navigate: vi.fn() });
  return null;
}

async function search(text: string) {
  await act(async () => latest.setQuery(text));
  await act(async () => vi.advanceTimersByTime(200));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  requests = [];
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("cancels a superseded search and ignores whatever it returns", async () => {
  await search("first");
  expect(requests[0]!.signal.aborted).toBe(false);

  await search("second");
  expect(requests.map((request) => request.q)).toEqual(["first", "second"]);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(requests[1]!.signal.aborted).toBe(false);

  await act(async () => requests[0]!.resolve([hit("Stale")]));
  expect(latest.searchHits).toEqual([]);
  expect(latest.searchLoading).toBe(true);

  await act(async () => requests[1]!.resolve([hit("Fresh")]));
  expect(latest.searchHits).toEqual([hit("Fresh")]);
  expect(latest.searchLoading).toBe(false);
  expect(latest.searchError).toBeNull();
});

it("does not report the cancelled request's rejection as a search error", async () => {
  await search("first");
  await search("second");
  await act(async () => requests[0]!.reject(requests[0]!.signal.reason));
  expect(latest.searchError).toBeNull();
  expect(latest.searchLoading).toBe(true);

  await act(async () => requests[1]!.resolve([hit("Fresh")]));
  expect(latest.searchHits).toEqual([hit("Fresh")]);
  expect(latest.searchLoading).toBe(false);
  expect(latest.searchError).toBeNull();
});

it("cancels the running search when the box is cleared or the sidebar unmounts", async () => {
  await search("first");
  await act(async () => latest.setQuery(""));
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(latest.searchLoading).toBe(false);

  await search("second");
  await act(async () => root.render(null));
  expect(requests[1]!.signal.aborted).toBe(true);
});

it("sends at most the search query limit and searches the first part of a longer query", async () => {
  const long = `${"a".repeat(SEARCH_QUERY_MAX_LENGTH)}tail`;
  await search(long);
  expect(requests[0]!.q).toBe("a".repeat(SEARCH_QUERY_MAX_LENGTH));
  expect(latest.searchError).toBeNull();
});

it("sends a short query unchanged", async () => {
  await search("  quarterly plan  ");
  expect(requests[0]!.q).toBe("quarterly plan");
});
