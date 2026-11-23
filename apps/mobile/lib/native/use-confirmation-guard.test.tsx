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

it("keeps a visible pane active across route blur, but invalidates hidden and unmounted panes", async () => {
  let begin!: ReturnType<typeof useConfirmationGuard>;
  function Harness({ shown }: { shown: boolean }) {
    begin = useConfirmationGuard(shown);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness shown />));
  const first = begin()!;
  // Explicit pane visibility does not install a route-focus visit.
  expect(focus()).toBeUndefined();
  expect(first.current()).toBe(true);
  expect(begin()).toBeUndefined();
  await act(async () => root.render(<Harness shown={false} />));
  expect(first.current()).toBe(false);
  expect(begin()).toBeUndefined();
  await act(async () => root.render(<Harness shown />));
  const second = begin()!;
  first.finish();
  expect(second.current()).toBe(true);
  await act(async () => root.unmount());
  expect(second.current()).toBe(false);
});
