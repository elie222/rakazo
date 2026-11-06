import { beforeEach, expect, it, vi } from "vitest";
import type { InboxSpace } from "./inbox-spaces";
import {
  getSearchInbox,
  isSearchInboxSession,
  searchInboxSession,
  setSearchInbox,
  subscribeSearchInbox,
} from "./search-inbox";

const state = vi.hoisted(() => ({
  generation: 1,
  apiBase: "https://example.test",
  sessionListener: () => {},
  unsubscribe: vi.fn(),
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({ currentApiBase: () => state.apiBase }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  subscribeSessionGeneration: (listener: () => void) => {
    state.sessionListener = listener;
    return state.unsubscribe;
  },
}));
beforeEach(() => {
  state.generation = 1;
  state.apiBase = "https://example.test";
  vi.clearAllMocks();
});

it.each([
  { generation: 2, apiBase: "https://example.test" },
  { generation: 1, apiBase: "https://other.example.test" },
])("rejects an inbox request after its session or server changes: %j", (next) => {
  const request = searchInboxSession();
  expect(isSearchInboxSession(request)).toBe(true);
  Object.assign(state, next);
  expect(isSearchInboxSession(request)).toBe(false);
  expect(isSearchInboxSession(searchInboxSession())).toBe(true);
});

it("publishes the exact home roster and unsubscribes", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeSearchInbox(listener);
  const spaces = [{ id: "space-a", bots: [], groups: [] }] as unknown as InboxSpace[];
  setSearchInbox(spaces);
  expect(getSearchInbox()).toBe(spaces);
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  setSearchInbox([]);
  expect(listener).toHaveBeenCalledOnce();
  expect(state.unsubscribe).toHaveBeenCalledOnce();
});
it("hides a prior session's or server's roster", () => {
  const spaces = [{ id: "space-a", bots: [], groups: [] }] as unknown as InboxSpace[];
  const listener = vi.fn();
  const unsubscribe = subscribeSearchInbox(listener);
  setSearchInbox(spaces);
  state.generation++;
  state.sessionListener();
  expect(listener).toHaveBeenCalledTimes(2);
  expect(getSearchInbox()).toEqual([]);
  setSearchInbox(spaces);
  state.apiBase = "https://other.example.test";
  expect(getSearchInbox()).toEqual([]);
  unsubscribe();
});
