// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardList } from "./board-list";

const { announce } = vi.hoisted(() => ({ announce: vi.fn() }));

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: announce },
  Platform: { OS: "android" },
  RefreshControl: () => null,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => (
    <p role={accessibilityRole}>{children}</p>
  ),
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/native", () => ({
  native: {},
  useResolvedAppearance: () => "light",
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsRow: () => null,
  useStackedSettings: () => false,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderBoard(error: string, refreshFailures = 0) {
  return act(async () =>
    root.render(
      <BoardList
        sections={[]}
        error={error}
        refreshFailures={refreshFailures}
        onMove={vi.fn()}
        onRefresh={vi.fn()}
      />,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  announce.mockReset();
});

it("shows a failed refresh as an alert that Android announces", async () => {
  await renderBoard("Try again.", 1);

  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not refresh the board. Try again.",
  );
  expect(announce).toHaveBeenCalledExactlyOnceWith("Could not refresh the board. Try again.");
});

it("announces every failed refresh, even when the message repeats", async () => {
  await renderBoard("Try again.", 1);
  await renderBoard("Try again.", 2);

  expect(announce).toHaveBeenCalledTimes(2);
  expect(announce).toHaveBeenLastCalledWith("Could not refresh the board. Try again.");
});

it("announces nothing while the board has no error", async () => {
  await renderBoard("");

  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(announce).not.toHaveBeenCalled();
});

it("announces an error once, when it appears rather than on every render", async () => {
  await renderBoard("");
  await renderBoard("Try again.", 1);
  await renderBoard("Try again.", 1);

  expect(announce).toHaveBeenCalledExactlyOnceWith("Could not refresh the board. Try again.");
});
