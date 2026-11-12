// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useConfirmationGuard } from "./use-confirmation-guard";

let focus!: () => () => void;
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => () => void) => {
    focus = effect;
    useEffect(effect, [effect]);
  },
}));

it("invalidates a previous visit, without letting its completion unlock the next one", async () => {
  let begin!: ReturnType<typeof useConfirmationGuard>;
  function Harness() {
    begin = useConfirmationGuard();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const blur = focus();
  const first = begin()!;
  expect(begin()).toBeUndefined();
  blur();
  expect(first.current()).toBe(false);
  expect(begin()).toBeUndefined();
  focus();
  const second = begin()!;
  first.finish();
  expect(second.current()).toBe(true);
  expect(begin()).toBeUndefined();
  second.finish();
  expect(begin()).toBeDefined();
  await act(async () => root.unmount());
  expect(second.current()).toBe(false);
});
