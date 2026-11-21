// @vitest-environment jsdom
import type { SearchHit } from "@rakazo/contracts";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../api/api";
import { useSearch } from "./use-search";

vi.mock("../api/api", () => ({ rpc: vi.fn() }));

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
let latest: ReturnType<typeof useSearch>;

function Probe({ query }: { query: string }) {
  latest = useSearch(query);
  return null;
}

async function search(query: string) {
  await act(async () => root.render(createElement(Probe, { query })));
  await act(async () => vi.advanceTimersByTime(200));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  requests = [];
  vi.mocked(rpc).mockImplementation(
    ((_proc: string, body: { q: string }, options: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        requests.push({
          q: body.q,
          signal: options.signal,
          resolve: (hits) => resolve({ hits }),
          reject,
        });
      })) as never,
  );
  root = createRoot(document.createElement("div"));
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
  expect(latest.hits).toEqual([]);
  expect(latest.loading).toBe(true);

  await act(async () => requests[1]!.resolve([hit("Fresh")]));
  expect(latest.hits).toEqual([hit("Fresh")]);
  expect(latest.loading).toBe(false);
  expect(latest.error).toBeNull();
});

it("does not report the cancelled request's rejection as a search error", async () => {
  await search("first");
  await search("second");
  await act(async () => requests[0]!.reject(requests[0]!.signal.reason));
  expect(latest.error).toBeNull();
  expect(latest.loading).toBe(true);

  await act(async () => requests[1]!.resolve([hit("Fresh")]));
  expect(latest.hits).toEqual([hit("Fresh")]);
  expect(latest.loading).toBe(false);
  expect(latest.error).toBeNull();
});

it("cancels the running search when the query is cleared or the screen unmounts", async () => {
  await search("first");
  await act(async () => root.render(createElement(Probe, { query: "" })));
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(latest.loading).toBe(false);

  await search("second");
  await act(async () => root.render(null));
  expect(requests[1]!.signal.aborted).toBe(true);
});

it.each(["first ", " first"])(
  "keeps the current hits and sends no request when only the spaces around the query change (%j)",
  async (spaced) => {
    await search("first");
    await act(async () => requests[0]!.resolve([hit("Fresh")]));
    expect(latest.hits).toEqual([hit("Fresh")]);

    await search(spaced);
    expect(requests).toHaveLength(1);
    expect(latest.hits).toEqual([hit("Fresh")]);
    expect(latest.loading).toBe(false);
    expect(latest.error).toBeNull();
  },
);

it("searches again and clears the hits when a retry is requested", async () => {
  await search("first");
  await act(async () => requests[0]!.resolve([hit("Fresh")]));

  await act(async () => latest.retry());
  await act(async () => vi.advanceTimersByTime(200));
  expect(requests.map((request) => request.q)).toEqual(["first", "first"]);
  expect(latest.hits).toEqual([]);
  expect(latest.loading).toBe(true);
});
