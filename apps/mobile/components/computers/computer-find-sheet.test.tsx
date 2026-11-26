// @vitest-environment jsdom

import type { ComputerElement } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | string) =>
      typeof strings === "string" ? strings : strings.join(""),
  }),
}));
vi.mock("react-native", () => ({
  Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? <div data-testid="modal">{children}</div> : null,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    onSubmitEditing,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    onSubmitEditing?: () => void;
  }) => (
    <input
      value={value}
      onChange={(event) => onChangeText?.(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmitEditing?.();
      }}
    />
  ),
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("react-native-safe-area-context", () => ({
  initialWindowMetrics: {},
  SafeAreaProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../lib/native/native", () => ({
  useMobileTokens: () => ({
    background: "#fff",
    foreground: "#000",
    mutedForeground: "#555",
    border: "#ccc",
    card: "#fff",
    destructive: "#f00",
    muted: "#eee",
  }),
}));
vi.mock("../native/glass-icon-button", () => ({
  GlassIconButton: ({
    accessibilityLabel,
    onPress,
  }: {
    accessibilityLabel: string;
    onPress: () => void;
  }) => <button type="button" aria-label={accessibilityLabel} onClick={onPress} />,
}));
vi.mock("../native/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    busy,
  }: {
    label: string;
    onPress: () => void;
    busy?: boolean;
  }) => (
    <button type="button" disabled={busy} onClick={onPress}>
      {label}
    </button>
  ),
}));

import { ComputerFindSheet } from "./computer-find-sheet";

const element: ComputerElement = {
  point: { x: 10, y: 20 },
  source: "ax",
  role: "button",
  name: "Save",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(overrides: Partial<Parameters<typeof ComputerFindSheet>[0]> = {}) {
  const props = {
    visible: true,
    query: "Save",
    results: [element],
    pending: false,
    error: null,
    clickPending: false,
    onQueryChange: vi.fn(),
    onFind: vi.fn(),
    onChoose: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  await act(async () => {
    root.render(<ComputerFindSheet {...props} />);
  });
  return props;
}

it("finds by name and chooses a result", async () => {
  const props = await render();
  const input = container.querySelector("input") as HTMLInputElement;
  expect(input.value).toBe("Save");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Home");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(props.onQueryChange).toHaveBeenCalledWith("Home");

  const find = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Find",
  );
  await act(async () => find?.click());
  expect(props.onFind).toHaveBeenCalledOnce();

  const save = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Save"),
  );
  await act(async () => save?.click());
  expect(props.onChoose).toHaveBeenCalledWith(element);
});

it("shows a failed lookup and closes from the native header", async () => {
  await render({ error: new Error("boom") });
  expect(container.textContent).toContain("boom");

  const close = container.querySelector('button[aria-label="Close find"]');
  await act(async () => close?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(container.querySelector('[data-testid="modal"]')).not.toBeNull();
});

it("renders nothing while the sheet is closed", async () => {
  await render({ visible: false });
  expect(container.querySelector('[data-testid="modal"]')).toBeNull();
});
