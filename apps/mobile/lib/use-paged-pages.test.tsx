// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "./api";
import { usePagedPages } from "./use-paged-pages";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./session", () => ({ registerSessionDiskCache: () => undefined }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});

const page = (id: string) => ({ id, title: id, pinned: false });
let hook: ReturnType<typeof usePagedPages>;
function Probe() {
  hook = usePagedPages({ botId: "b1" });
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const items = () => (hook.listed.status === "ready" ? hook.listed.items.map((p) => p.id) : []);

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("runs one Show more at a time, drops a page that started before a reload, and lists each page once", async () => {
  const read = vi.mocked(rpc);
  read.mockResolvedValueOnce({
    items: ["a", "b", "c", "d", "e"].map(page),
    nextCursor: "c1",
  } as never);
  await act(async () => root.render(createElement(Probe)));
  expect(items()).toEqual(["a", "b", "c", "d", "e"]);

  // A double tap asks once.
  const more = deferred<unknown>();
  read.mockReturnValueOnce(more.promise as never);
  await act(async () => {
    void hook.showMore();
    void hook.showMore();
  });
  expect(read).toHaveBeenCalledTimes(2);
  // The list moved under it (a page was updated), so the next page repeats one.
  await act(async () => more.resolve({ items: [page("e"), page("f")], nextCursor: "c2" }));
  expect(items()).toEqual(["a", "b", "c", "d", "e", "f"]);

  // A pin reloads the list while another Show more is out: its late answer is dropped.
  const late = deferred<unknown>();
  read.mockReturnValueOnce(late.promise as never);
  await act(async () => void hook.showMore());
  read.mockResolvedValueOnce({ items: [page("f"), page("a")], nextCursor: null } as never);
  await act(async () => hook.refresh());
  await act(async () => late.resolve({ items: [page("old")], nextCursor: null }));
  expect(items()).toEqual(["f", "a"]);
});

it("drops a Show more failure that started before a reload", async () => {
  const read = vi.mocked(rpc);
  read.mockReset();
  read.mockResolvedValueOnce({ items: [page("a")], nextCursor: "c1" } as never);
  await act(async () => root.render(createElement(Probe)));
  const late = deferred<unknown>();
  read.mockReturnValueOnce(late.promise.then(() => Promise.reject(new Error("offline"))) as never);
  let shown: unknown = "pending";
  await act(async () => {
    hook.showMore().then(
      () => {
        shown = "quiet";
      },
      (error: unknown) => {
        shown = error;
      },
    );
  });
  read.mockResolvedValueOnce({ items: [page("b")], nextCursor: null } as never);
  await act(async () => hook.refresh());
  await act(async () => late.resolve(undefined));
  expect(shown).toBe("quiet");
  expect(items()).toEqual(["b"]);
});

it("keeps the pages shown when the list comes back on screen, newest first", async () => {
  const read = vi.mocked(rpc);
  read.mockReset();
  read.mockResolvedValueOnce({
    items: ["a", "b", "c", "d", "e"].map(page),
    nextCursor: "c1",
  } as never);
  await act(async () => root.render(createElement(Probe)));
  read.mockResolvedValueOnce({ items: ["f", "g", "h"].map(page), nextCursor: "c2" } as never);
  await act(async () => hook.showMore());
  expect(items()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);

  // Back from a page: as many as were shown are read again, with a new page on top.
  read.mockResolvedValueOnce({
    items: ["new", "a", "b", "c", "d", "e", "f", "g"].map(page),
    nextCursor: "c3",
  } as never);
  await act(async () => hook.refresh());
  expect(read).toHaveBeenLastCalledWith("pages/list", { botId: "b1", limit: 8 });
  expect(items()).toEqual(["new", "a", "b", "c", "d", "e", "f", "g"]);
  read.mockResolvedValueOnce({ items: [page("h")], nextCursor: null } as never);
  await act(async () => hook.showMore());
  expect(read).toHaveBeenLastCalledWith("pages/list", { botId: "b1", limit: 5, cursor: "c3" });
  expect(items()).toEqual(["new", "a", "b", "c", "d", "e", "f", "g", "h"]);
});

it("reads five at first and never more than the server lists at once", async () => {
  const read = vi.mocked(rpc);
  read.mockReset();
  const many = Array.from({ length: 70 }, (_, index) => page(`p${index}`));
  read.mockResolvedValue({ items: many, nextCursor: "c1" } as never);
  await act(async () => root.render(createElement(Probe)));
  expect(read).toHaveBeenLastCalledWith("pages/list", { botId: "b1", limit: 5 });
  await act(async () => hook.refresh());
  expect(read).toHaveBeenLastCalledWith("pages/list", { botId: "b1", limit: 60 });
  read.mockReset();
});

it("starts from five again when the screen moves to another bot or a group", async () => {
  const read = vi.mocked(rpc);
  read.mockReset();
  read.mockResolvedValue({
    items: Array.from({ length: 8 }, (_, i) => page(`p${i}`)),
    nextCursor: "c",
  } as never);
  function Owner({ owner }: { owner: { botId?: string; groupId?: string } }) {
    hook = usePagedPages(owner);
    return null;
  }
  await act(async () => root.render(createElement(Owner, { owner: { botId: "b1" } })));
  await act(async () => hook.refresh());
  expect(read).toHaveBeenLastCalledWith("pages/list", { botId: "b1", limit: 8 });
  await act(async () => root.render(createElement(Owner, { owner: { botId: "b2" } })));
  expect(read).toHaveBeenLastCalledWith("pages/list", { botId: "b2", limit: 5 });
  await act(async () => root.render(createElement(Owner, { owner: { groupId: "g1" } })));
  expect(read).toHaveBeenLastCalledWith("pages/list", { groupId: "g1", limit: 5 });
  read.mockReset();
});
