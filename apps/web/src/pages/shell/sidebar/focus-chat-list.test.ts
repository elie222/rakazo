// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { focusChatList } from "./focus-chat-list";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  document.body.replaceChildren();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function runFrame() {
  const [frame, callback] = frames.entries().next().value ?? [];
  if (frame === undefined) return;
  frames.delete(frame);
  callback?.(0);
}

it("waits for a lazily rendered search control before focusing it", () => {
  focusChatList();
  expect(frames.size).toBe(1);

  // The destination shell is still behind its loading fallback.
  runFrame();
  expect(frames.size).toBe(1);

  const search = document.createElement("button");
  search.dataset.testid = "sidebar-search-trigger";
  document.body.append(search);
  runFrame();

  expect(document.activeElement).toBe(search);
  expect(frames.size).toBe(0);
});

it("gives up instead of polling forever when the control never appears", () => {
  focusChatList();
  for (let frame = 0; frame < 61; frame += 1) runFrame();
  expect(frames.size).toBe(0);
});

it("leaves focus alone when the user moved on before the control appeared", () => {
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  focusChatList();

  elsewhere.focus();
  const search = document.createElement("button");
  search.dataset.testid = "sidebar-search-trigger";
  document.body.append(search);
  runFrame();

  expect(document.activeElement).toBe(elsewhere);
});

it("cancels the previous wait when a new handoff starts", () => {
  focusChatList();
  focusChatList();
  expect(frames.size).toBe(1);

  runFrame();
  expect(frames.size).toBe(1);

  const search = document.createElement("button");
  search.dataset.testid = "sidebar-search-trigger";
  document.body.append(search);
  runFrame();
  expect(document.activeElement).toBe(search);
});
