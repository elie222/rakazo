// @vitest-environment jsdom

import type { SearchHit } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { SpaceSearchResults } from "./SpaceSearch";
import { useSidebarSearch } from "./shell/use-sidebar-search";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function file(artifactId: string): SearchHit {
  return {
    kind: "file",
    botId: "bot-1",
    botName: "Scout",
    title: `${artifactId}.png`,
    snippet: "image/png, 10 bytes",
    messageId: "message-1",
    seq: 4,
    artifactId,
  };
}

it("renders every file sent in one message without duplicate-key errors", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () =>
    root.render(
      <SpaceSearchResults
        hits={[file("artifact-1"), file("artifact-2")]}
        loading={false}
        error={null}
        onSelect={() => {}}
      />,
    ),
  );
  expect(error).not.toHaveBeenCalled();
  expect(container.querySelectorAll("button")).toHaveLength(2);
  expect(container.querySelector("button")?.textContent).toContain("File");
});

it("says the search failed instead of no results, ignoring superseded and cleared requests", async () => {
  vi.useFakeTimers();
  const pending: { resolve: (hits: SearchHit[]) => void; reject: (error: unknown) => void }[] = [];
  const query = vi.fn(
    () =>
      new Promise<{ hits: SearchHit[] }>((resolve, reject) =>
        pending.push({ resolve: (hits) => resolve({ hits }), reject }),
      ),
  );
  let setQuery!: (query: string) => void;
  function Harness() {
    const search = useSidebarSearch({
      rpc: { search: { query } } as unknown as Parameters<typeof useSidebarSearch>[0]["rpc"],
      navigate: vi.fn(),
    });
    setQuery = search.setQuery;
    return (
      <SpaceSearchResults
        hits={search.searchHits}
        loading={search.searchLoading}
        error={search.searchError}
        onSelect={() => {}}
      />
    );
  }
  async function search(text: string) {
    await act(async () => setQuery(text));
    await act(async () => vi.advanceTimersByTime(200));
  }
  await act(async () => root.render(<Harness />));

  await search("first");
  await act(async () => pending[0]!.reject(new Error("Search is unavailable right now")));
  expect(container.textContent).toBe("Search is unavailable right now");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();

  await search("second");
  expect(container.textContent).toBe("Searching…");
  await act(async () => pending[1]!.resolve([]));
  expect(container.textContent).toBe("No results");

  await search("third");
  await search("fourth");
  await act(async () => pending[2]!.reject(new TypeError("Failed to fetch")));
  expect(container.textContent).toBe("Searching…");
  await act(async () => pending[3]!.resolve([file("artifact-1")]));
  expect(container.querySelectorAll("button")).toHaveLength(1);

  await search("fifth");
  await act(async () => pending[4]!.reject(new TypeError("Failed to fetch")));
  expect(container.textContent).toBe("Could not reach the server");
  await act(async () => setQuery(""));
  await act(async () => setQuery("sixth"));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => vi.advanceTimersByTime(200));
  await act(async () => setQuery(""));
  await act(async () => pending[5]!.reject(new Error("Search is unavailable right now")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(query).toHaveBeenCalledTimes(6);
});
