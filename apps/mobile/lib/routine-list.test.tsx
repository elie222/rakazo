// @vitest-environment jsdom

import type { Routine } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useEffect, useSyncExternalStore } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoutineList } from "../components/routine-list.ios";

type Modifier = { name: string; value: unknown };

const swift = vi.hoisted(() => ({
  scheme: "dark" as "dark" | "light",
  listeners: new Set<() => void>(),
  hostMounts: 0,
  separators: [] as Modifier[][],
  rows: [] as Modifier[][],
  toggles: [] as Array<{ label?: string; modifiers?: Modifier[] }>,
  actions: 0,
  buttons: [] as Array<{ label?: string; role?: string; modifiers?: Modifier[] }>,
}));

vi.mock("@expo/ui/swift-ui", () => {
  const wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: {
      label?: string;
      role?: string;
      modifiers?: Modifier[];
      children?: ReactNode;
    }) => {
      swift.buttons.push(props);
      return <div>{props.children}</div>;
    },
    Host: ({ children }: { children?: ReactNode }) => {
      useEffect(() => {
        swift.hostMounts += 1;
      }, []);
      return <div>{children}</div>;
    },
    HStack: wrap,
    List: Object.assign(wrap, { ForEach: wrap }),
    Rectangle: ({ modifiers }: { modifiers?: Modifier[] }) => {
      swift.separators.push(modifiers ?? []);
      return null;
    },
    Section: wrap,
    Spacer: () => null,
    SwipeActions: Object.assign(
      ({ children, modifiers }: { children?: ReactNode; modifiers?: Modifier[] }) => {
        swift.rows.push(modifiers ?? []);
        return <div>{children}</div>;
      },
      {
        Actions: ({ children }: { children?: ReactNode }) => {
          swift.actions += 1;
          return <div>{children}</div>;
        },
      },
    ),
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Toggle: (props: { label?: string; modifiers?: Modifier[] }) => {
      swift.toggles.push(props);
      return null;
    },
    VStack: wrap,
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier =
    (name: string) =>
    (...value: unknown[]) => ({ name, value: value.length > 1 ? value : value[0] });
  return {
    ...Object.fromEntries(
      [
        "accessibilityLabel",
        "buttonStyle",
        "contentShape",
        "disabled",
        "font",
        "foregroundStyle",
        "frame",
        "labelStyle",
        "labelsHidden",
        "lineLimit",
        "listRowBackground",
        "listRowInsets",
        "listRowSeparator",
        "listSectionMargins",
        "listStyle",
        "padding",
        "scrollContentBackground",
        "tint",
        "toggleStyle",
      ].map((name) => [name, modifier(name)]),
    ),
    shapes: { rectangle: () => "rectangle" },
  };
});
vi.mock("react-native", () => ({
  PlatformColor: (name: string) => ({ semantic: [name] }),
  StyleSheet: { hairlineWidth: 0.5 },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./native", () => {
  const palette = () =>
    swift.scheme === "dark"
      ? { separator: "dark-border", groupedPage: "dark-page", groupedCell: "dark-card" }
      : { separator: "light-border", groupedPage: "light-page", groupedCell: "light-card" };
  return {
    native: {
      get separator() {
        return palette().separator;
      },
      get groupedPage() {
        return palette().groupedPage;
      },
      get groupedCell() {
        return palette().groupedCell;
      },
    },
    useMobileTokens: () => ({ foreground: "ink" }),
    useResolvedAppearance: () =>
      useSyncExternalStore(
        (listener) => {
          swift.listeners.add(listener);
          return () => void swift.listeners.delete(listener);
        },
        () => swift.scheme,
      ),
  };
});
vi.mock("./native-controls", () => ({ iosAtLeast: () => true }));
vi.mock("./floating-header", () => ({ useFloatingHeaderInset: () => 0 }));
vi.mock("./i18n", () => ({
  getActiveUiLocale: () => "en",
  t: (text: string, values: Record<string, string> = {}) =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match),
  useI18n: () => ({
    t: (text: string, values: Record<string, string> = {}) =>
      text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match),
  }),
}));

const routine = (id: string, name: string, partial: Partial<Routine> = {}): Routine => ({
  id,
  botId: "bot-fixture",
  name,
  prompt: "Check the inbox",
  crons: ["0 7 * * *"],
  timezone: "UTC",
  active: true,
  notify: false,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: null,
  watchState: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...partial,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.assign(swift, { scheme: "dark", hostMounts: 0, actions: 0 });
  reset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function reset() {
  swift.separators = [];
  swift.rows = [];
  swift.toggles = [];
  swift.buttons = [];
  swift.actions = 0;
}

function render(props: Partial<Parameters<typeof RoutineList>[0]> = {}) {
  act(() =>
    root.render(
      <RoutineList
        routines={[routine("r1", "Morning digest"), routine("r2", "Weekly report")]}
        timeZone="UTC"
        canDelete
        onOpen={vi.fn()}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        {...props}
      />,
    ),
  );
}

function switchAppearance(scheme: "dark" | "light") {
  reset();
  act(() => {
    swift.scheme = scheme;
    for (const listener of swift.listeners) listener();
  });
}

const colour = (modifiers: Modifier[], name: string) =>
  modifiers.find((modifier) => modifier.name === name)?.value;

it("draws the settings groups' divider between rows, not the system separator", () => {
  render();
  // One divider, above the second row: 2 px of the settings separator, inset like SettingsGroup.
  expect(swift.separators).toEqual([
    [
      { name: "frame", value: { height: 1 } },
      { name: "foregroundStyle", value: "dark-border" },
      { name: "padding", value: { leading: 16 } },
    ],
  ]);
  for (const row of swift.rows) {
    expect(colour(row, "listRowSeparator")).toBe("hidden");
    expect(colour(row, "listRowBackground")).toBe("dark-card");
  }
});

it.each([
  ["dark", "light"],
  ["light", "dark"],
] as const)("follows a live %s to %s switch while the list stays open", (from, to) => {
  swift.scheme = from;
  render();
  expect(swift.hostMounts).toBe(1);
  expect(colour(swift.separators[0]!, "foregroundStyle")).toBe(`${from}-border`);

  switchAppearance(to);
  // The native list is rebuilt, so nothing keeps the old theme's colours.
  expect(swift.hostMounts).toBe(2);
  expect(colour(swift.separators[0]!, "foregroundStyle")).toBe(`${to}-border`);
  for (const row of swift.rows) expect(colour(row, "listRowBackground")).toBe(`${to}-card`);
});

it("offers a red delete without the destructive role, and none while a delete runs", () => {
  render();
  expect(swift.actions).toBe(2);
  const trash = swift.buttons.filter((button) => button.label === "Delete");
  expect(trash).toHaveLength(2);
  for (const button of trash) {
    expect(button.role).toBeUndefined();
    expect(colour(button.modifiers ?? [], "tint")).toEqual({ semantic: ["systemRed"] });
  }
  expect(colour(trash[0]!.modifiers ?? [], "accessibilityLabel")).toBe("Delete Morning digest");

  reset();
  render({ canDelete: false });
  expect(swift.actions).toBe(0);
});

it("disables the switch and delete for a routine only its creator can change", () => {
  render({ routines: [routine("r1", "Morning digest", { editable: false })] });
  expect(swift.actions).toBe(0);
  expect(swift.toggles).toHaveLength(1);
  expect(swift.toggles[0]!.label).toBe("Active: Morning digest");
  expect(colour(swift.toggles[0]!.modifiers ?? [], "disabled")).toBe(true);
});
