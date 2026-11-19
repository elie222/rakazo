// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { Routine } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoutineOwnerNote } from "./access-note";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const routine = (runsAs: Routine["runsAs"]) => ({ id: "r1", runsAs }) as Routine;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(editing: Routine | null) {
  await act(async () => root.render(<RoutineOwnerNote routine={editing} />));
  return container.querySelector('[data-testid="routine-owner-note"]')?.textContent ?? null;
}

it("says that only the owner can change another member's routine", async () => {
  expect(await render(routine({ name: "Dana", isViewer: false }))).toBe(
    "Only Dana can change this routine.",
  );
});

it("says nothing for the viewer's own routine, a new one, or one with no known owner", async () => {
  expect(await render(routine({ name: "Riley", isViewer: true }))).toBeNull();
  expect(await render(null)).toBeNull();
  expect(await render(routine(null))).toBeNull();
  expect(await render(routine(undefined))).toBeNull();
});
