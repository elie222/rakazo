// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { Routine } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoutineList } from "./RoutineList";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

function routine(index: number): Routine {
  return {
    id: `routine-${index}`,
    botId: "bot-1",
    name: `Routine ${index}`,
    prompt: "",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    emailSenders: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    watch: null,
    watchState: null,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

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

async function render(props: Partial<ComponentProps<typeof RoutineList>>) {
  const handlers = { onCreate: vi.fn(), onEdit: vi.fn(), onStop: vi.fn(), onToggle: vi.fn() };
  await act(async () => {
    root.render(<RoutineList routines={[]} loaded {...handlers} {...props} />);
  });
  return handlers;
}

it("turns a routine off from its row's switch", async () => {
  const first = routine(1);
  const { onToggle, onEdit } = await render({ routines: [first] });
  const toggle = container.querySelector<HTMLElement>('[aria-label="Turn Routine 1 on or off"]');
  expect(toggle?.getAttribute("role")).toBe("switch");
  await act(async () => toggle?.click());
  expect(onToggle).toHaveBeenCalledExactlyOnceWith(first, false);
  expect(onEdit).not.toHaveBeenCalled();
});

it("previews only the first three routines", async () => {
  await render({ routines: [1, 2, 3, 4].map(routine), preview: true });
  expect([...container.querySelectorAll('[role="switch"]')]).toHaveLength(3);
  expect(container.textContent).not.toContain("Routine 4");
});

it("previews a New routine row once a bot has none", async () => {
  const { onCreate } = await render({ preview: true });
  const create = container.querySelector<HTMLButtonElement>(
    '[data-testid="routine-create-button"]',
  );
  expect(create?.textContent).toBe("New routine");
  await act(async () => create?.click());
  expect(onCreate).toHaveBeenCalledOnce();
});

it("still offers New routine when a bot's routines have not loaded", async () => {
  await render({ preview: true, loaded: false });
  expect(container.querySelector('[data-testid="routine-create-button"]')).not.toBeNull();
});

it("previews the soonest scheduled routines first", async () => {
  const later = { ...routine(1), nextRunAt: "2026-11-20T09:00:00.000Z" };
  const paused = { ...routine(2), active: false };
  const soon = { ...routine(3), nextRunAt: "2026-11-17T09:00:00.000Z" };
  const soonest = { ...routine(4), nextRunAt: "2026-11-16T09:00:00.000Z" };
  await render({ routines: [later, paused, soon, soonest], preview: true });
  expect(
    [...container.querySelectorAll('[role="switch"]')].map((node) =>
      node.getAttribute("aria-label"),
    ),
  ).toEqual(["Turn Routine 4 on or off", "Turn Routine 3 on or off", "Turn Routine 1 on or off"]);
});

it("offers no switch to restart a one-shot that already ran", async () => {
  const done = {
    ...routine(1),
    active: false,
    crons: ["@once"],
    lastRunAt: "2026-11-16T09:00:00.000Z",
  };
  await render({ routines: [done] });
  const toggle = container.querySelector('[aria-label="Turn Routine 1 on or off"]');
  expect(toggle?.hasAttribute("data-disabled")).toBe(true);
});
