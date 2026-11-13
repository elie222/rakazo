// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ComputersSettings from "../app/(settings)/computers";
import { listUserDevices, removeUserDevice } from "./user-devices";

vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "#f00" }) }));
vi.mock("./native", () => ({
  native: { groupedPage: "#fff", secondaryLabel: "#888" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({ apiBase: "https://app.example.test", headers: {} }),
}));
vi.mock("./user-devices", () => ({
  listUserDevices: vi.fn(),
  removeUserDevice: vi.fn(),
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    value,
    accessibilityLabel,
    disabled,
    onPress,
  }: {
    title: string;
    value?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={accessibilityLabel ?? title}
      disabled={disabled}
      onClick={onPress}
    >
      {title}
      {value}
    </button>
  ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: ({
      children,
      refreshControl,
    }: {
      children?: ReactNode;
      refreshControl?: ReactNode;
    }) => (
      <div>
        {refreshControl}
        {children}
      </div>
    ),
    RefreshControl: ({ onRefresh }: { onRefresh: () => void }) => (
      <button type="button" aria-label="Refresh" onClick={onRefresh} />
    ),
    Text: ({ children, ...props }: { children?: ReactNode; role?: string }) => (
      <p role={props.role} {...props}>
        {children}
      </p>
    ),
    ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel?: string }) => (
      <span role="status" aria-label={accessibilityLabel} />
    ),
    Alert: { alert: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function render() {
  await act(async () => root.render(<ComputersSettings />));
  await settle();
}

const laptop = { deviceId: "d1", name: "Laptop", connected: true };
const desk = { deviceId: "d2", name: "Desk PC", connected: false };

function confirmRemove() {
  const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? [];
  const remove = buttons.find((button: { style?: string }) => button.style === "destructive");
  return remove as { onPress?: () => void } | undefined;
}

it("lists computers with their status and revokes one after confirmation", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([laptop, desk]);
  vi.mocked(removeUserDevice).mockResolvedValue();
  await render();
  expect(container.textContent).toContain("LaptopConnected");
  expect(container.textContent).toContain("Desk PCOffline");

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Desk PC"]')?.click(),
  );
  expect(Alert.alert).toHaveBeenCalledWith(
    "Remove Desk PC?",
    "This computer will stop running bots for your account",
    expect.arrayContaining([
      expect.objectContaining({ text: "Cancel", style: "cancel" }),
      expect.objectContaining({ text: "Remove", style: "destructive" }),
    ]),
  );
  expect(removeUserDevice).not.toHaveBeenCalled();

  await act(async () => confirmRemove()?.onPress?.());
  await settle();
  expect(removeUserDevice).toHaveBeenCalledWith("d2");
  expect(container.textContent).not.toContain("Desk PC");
  expect(container.textContent).toContain("LaptopConnected");
});

it("says when none are paired, and retries a failed load", async () => {
  vi.mocked(listUserDevices).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
  await render();
  expect(container.textContent).toContain("offline");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  await act(async () => retry?.click());
  await settle();
  expect(container.textContent).toContain("No paired computers");
  expect(container.textContent).not.toContain("offline");
});

it("restores a computer when revoke fails", async () => {
  vi.mocked(listUserDevices).mockResolvedValue([laptop]);
  vi.mocked(removeUserDevice).mockRejectedValue(new Error("offline"));
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop"]')?.click(),
  );
  await act(async () => confirmRemove()?.onPress?.());
  await settle();
  expect(container.textContent).toContain("LaptopConnected");
  expect(
    container.querySelector("[role=alert], [accessibilityrole=alert], p")?.textContent,
  ).toContain("offline");
});

it("keeps the newest list when an earlier load finishes last", async () => {
  let finishFirst!: (devices: (typeof laptop)[]) => void;
  vi.mocked(listUserDevices)
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
    .mockResolvedValueOnce([]);
  await render();
  const refresh = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.click();
  await act(async () => refresh());
  await act(async () => refresh());
  await settle();
  expect(container.textContent).toContain("No paired computers");
  await act(async () => finishFirst([laptop]));
  await settle();
  expect(container.textContent).not.toContain("Laptop");
});
