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

function renderBoard(error: string) {
  return act(async () =>
    root.render(<BoardList sections={[]} error={error} onMove={vi.fn()} onRefresh={vi.fn()} />),
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
  await renderBoard("Try again.");

  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Try again.");
  expect(announce).toHaveBeenCalledExactlyOnceWith("Try again.");
});

it("announces nothing while the board has no error", async () => {
  await renderBoard("");

  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(announce).not.toHaveBeenCalled();
});

it("announces an error once, when it appears rather than on every render", async () => {
  await renderBoard("");
  await renderBoard("Try again.");
  await renderBoard("Try again.");

  expect(announce).toHaveBeenCalledExactlyOnceWith("Try again.");
});
