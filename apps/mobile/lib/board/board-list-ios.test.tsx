// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardList } from "./board-list.ios";

const { announce } = vi.hoisted(() => ({ announce: vi.fn() }));

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String.raw }) }));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: announce },
}));
vi.mock("@expo/ui/swift-ui", () => ({
  Button: () => null,
  Menu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  // The footer is the only text this list shows above its columns.
  Section: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => (
    <section>
      {footer}
      {children}
    </section>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  VStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  contentShape: () => undefined,
  font: () => undefined,
  foregroundStyle: () => undefined,
  frame: () => undefined,
  lineLimit: () => undefined,
  multilineTextAlignment: () => undefined,
  refreshable: () => undefined,
  shapes: { rectangle: () => undefined },
}));
vi.mock("../../components/native/native-inset-list", () => ({
  NativeInsetList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useInsetListEdges: () => ({ modifiers: [], header: undefined, footer: undefined }),
}));
vi.mock("../layout/floating-header", () => ({ useFloatingHeaderInset: () => 0 }));
vi.mock("../native/native", () => ({
  native: {},
  useMobileTokens: () => ({ foreground: "" }),
  useResolvedAppearance: () => "light",
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

it("shows a failed refresh in the list footer and announces it to VoiceOver", async () => {
  await renderBoard("Try again.", 1);

  expect(host.textContent).toContain("Could not refresh the board. Try again.");
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

  expect(announce).not.toHaveBeenCalled();
});

it("announces an error once, when it appears rather than on every render", async () => {
  await renderBoard("");
  await renderBoard("Try again.", 1);
  await renderBoard("Try again.", 1);

  expect(announce).toHaveBeenCalledExactlyOnceWith("Could not refresh the board. Try again.");
});
