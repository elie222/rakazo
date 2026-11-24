// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PageStateSave } from "./page-state";
import { pageStateRetryable, usePageStateQueue, withSavedValues } from "./page-state";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("saves a page's changes one request at a time, retrying a failure and dropping a refusal", () => {
  const sent: PageStateSave[] = [];
  let queue!: ReturnType<typeof usePageStateQueue>;
  function Queue() {
    queue = usePageStateQueue("page-1", (save) => sent.push(save));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Queue />));
  queue.save({ a: 1 });
  queue.save({ b: 2 });
  expect(sent).toEqual([{ pageId: "page-1", values: { a: 1 } }]);
  queue.failed(sent[0]!, new Error("offline"));
  queue.save({ c: 3 });
  expect(sent[1]).toEqual({ pageId: "page-1", values: { a: 1, b: 2, c: 3 } });
  queue.save({ d: 4 });
  queue.failed(sent[1]!, Object.assign(new Error("too much"), { code: "PAGE_STATE_LIMIT" }));
  expect(sent[2]).toEqual({ pageId: "page-1", values: { d: 4 } });
  queue.saved();
  queue.retry();
  expect(sent).toHaveLength(3);
  expect(pageStateRetryable(new Error("offline"))).toBe(true);
  expect(pageStateRetryable({ code: "PAGE_STATE_LIMIT" })).toBe(false);
  act(() => root.unmount());
});

it("adds saved values to a page read that carries the reader's values, and only to one", () => {
  const read = { code: "x", readerState: { a: 1, b: 2 } };
  expect(withSavedValues(read, { b: 3 })).toEqual({ code: "x", readerState: { a: 1, b: 3 } });
  const older: { code: string; readerState?: { b: number } } = { code: "old version" };
  expect(withSavedValues(older, { b: 3 })).toEqual({ code: "old version" });
});
