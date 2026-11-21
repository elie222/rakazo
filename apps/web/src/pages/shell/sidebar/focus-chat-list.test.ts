// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { focusChatList } from "./focus-chat-list";

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  document.body.replaceChildren();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("waits for a lazily rendered search control before focusing it", () => {
  focusChatList();
  expect(frames).toHaveLength(1);

  // The destination shell is still behind its loading fallback.
  frames.shift()!(0);
  expect(frames).toHaveLength(1);

  const search = document.createElement("button");
  search.dataset.testid = "sidebar-search-trigger";
  document.body.append(search);
  frames.shift()!(0);

  expect(document.activeElement).toBe(search);
  expect(frames).toHaveLength(0);
});

it("gives up instead of polling forever when the control never appears", () => {
  focusChatList();
  for (let frame = 0; frame < 61; frame += 1) frames.shift()?.(0);
  expect(frames).toHaveLength(0);
});
