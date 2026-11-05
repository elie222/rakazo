// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { claimedMotionSlots, MAX_WORKING_MOTION, useMotionSlot } from "./use-motion-slot";

const granted = new Map<number, boolean>();

function Face({ id, wanted }: { id: number; wanted: boolean }) {
  granted.set(id, useMotionSlot(wanted));
  return null;
}

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  granted.clear();
});

function render(ids: number[], wanted = true) {
  return act(async () => root!.render(ids.map((id) => <Face key={id} id={id} wanted={wanted} />)));
}

it("lets only the first few working faces move, and hands a freed slot to the next", async () => {
  root = createRoot(document.createElement("div"));
  const ids = Array.from({ length: MAX_WORKING_MOTION + 2 }, (_, index) => index);
  await render(ids);
  expect([...granted.values()].filter(Boolean)).toHaveLength(MAX_WORKING_MOTION);
  expect(granted.get(MAX_WORKING_MOTION)).toBe(false);

  await render(ids.slice(1));
  expect(granted.get(MAX_WORKING_MOTION)).toBe(true);
  expect(granted.get(MAX_WORKING_MOTION + 1)).toBe(false);

  granted.clear();
  await render(ids.slice(1), false);
  expect([...granted.values()].some(Boolean)).toBe(false);
  expect(claimedMotionSlots()).toBe(0);
});

function Status({ wanted }: { wanted: boolean }) {
  granted.set(-1, useMotionSlot(wanted, true));
  return null;
}

it("lets the status row move even when the roster has taken every slot", async () => {
  root = createRoot(document.createElement("div"));
  const ids = Array.from({ length: MAX_WORKING_MOTION }, (_, index) => index);
  await act(async () =>
    root!.render([
      ...ids.map((id) => <Face key={id} id={id} wanted />),
      <Status key="status" wanted />,
    ]),
  );
  expect(granted.get(-1)).toBe(true);
  expect(granted.get(MAX_WORKING_MOTION - 1)).toBe(false);
});
