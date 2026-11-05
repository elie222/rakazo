// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { watchAvatarLook } from "./avatar-look";

function mockReducedMotion(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    set(value: boolean) {
      query.matches = value;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("follows a reduced-motion change while faces are mounted", () => {
  const motion = mockReducedMotion(false);
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const stop = watchAvatarLook();
  expect(add).toHaveBeenCalledWith("pointermove", expect.any(Function), { passive: true });

  motion.set(true);
  expect(remove).toHaveBeenCalledWith("pointermove", expect.any(Function));

  add.mockClear();
  motion.set(false);
  expect(add).toHaveBeenCalledWith("pointermove", expect.any(Function), { passive: true });

  stop();
  expect(motion.listeners.size).toBe(0);
});

it("starts still under reduced motion and looks once it is turned off", () => {
  const motion = mockReducedMotion(true);
  const add = vi.spyOn(window, "addEventListener");
  const stop = watchAvatarLook();
  expect(add).not.toHaveBeenCalledWith("pointermove", expect.any(Function), { passive: true });
  motion.set(false);
  expect(add).toHaveBeenCalledWith("pointermove", expect.any(Function), { passive: true });
  stop();
});
