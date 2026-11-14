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
  useFocusEffect: (effect: () => (() => void) | undefined) =>
    useEffect(() => {
      focus = () => {
        blur = effect() ?? (() => {});
      };
      focus();
      return () => blur();
    }, [effect]),
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
    RefreshControl: ({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) => (
      <button type="button" aria-label="Refresh" aria-busy={refreshing} onClick={onRefresh} />
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
let focus: () => void;
let blur: () => void;
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
  vi.resetAllMocks();
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
  vi.mocked(listUserDevices).mockResolvedValueOnce([laptop, desk]).mockResolvedValue([laptop]);
  vi.mocked(removeUserDevice).mockResolvedValue();
  await render();
  expect(container.textContent).toContain("LaptopConnected");
  expect(container.textContent).toContain("Desk PCOffline");
  expect(container.querySelector('[aria-label="Remove Laptop, Connected"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Remove Desk PC, Offline"]')).not.toBeNull();

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Desk PC, Offline"]')?.click(),
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

it("re-lists after a revoke error and keeps the error visible", async () => {
  vi.mocked(listUserDevices).mockResolvedValueOnce([laptop]).mockResolvedValueOnce([]);
  vi.mocked(removeUserDevice).mockRejectedValue(new Error("offline"));
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop, Connected"]')?.click(),
  );
  await act(async () => confirmRemove()?.onPress?.());
  await settle();
  expect(listUserDevices).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Laptop");
  expect(container.textContent).toContain("offline");
  expect(container.textContent).not.toContain("Retry");
});

it("keeps the revoke error when reconciliation also fails", async () => {
  vi.mocked(listUserDevices)
    .mockResolvedValueOnce([laptop])
    .mockRejectedValueOnce(new Error("list failed"));
  vi.mocked(removeUserDevice).mockRejectedValue({});
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop, Connected"]')?.click(),
  );
  await act(async () => confirmRemove()?.onPress?.());
  await settle();
  expect(container.textContent).toContain("LaptopConnected");
  expect(container.textContent).toContain("Could not remove");
  expect(container.textContent).toContain("Retry");
});

it("retries a failed reload after a list exists", async () => {
  vi.mocked(listUserDevices)
    .mockResolvedValueOnce([laptop])
    .mockRejectedValueOnce(new Error("list failed"))
    .mockResolvedValueOnce([desk]);
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.click(),
  );
  expect(container.textContent).toContain("LaptopConnected");
  expect(container.textContent).toContain("list failed");
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  expect(retry).toBeDefined();
  await act(async () => retry?.click());
  expect(container.textContent).toContain("Desk PCOffline");
  expect(container.textContent).not.toContain("list failed");
  expect(container.textContent).not.toContain("Retry");
});

function refreshBusy() {
  return container.querySelector('[aria-label="Refresh"]')?.getAttribute("aria-busy");
}

it("keeps refreshing until the newest refresh finishes", async () => {
  let finishFirst!: (devices: (typeof laptop)[]) => void;
  let finishSecond!: (devices: (typeof laptop)[]) => void;
  vi.mocked(listUserDevices)
    .mockResolvedValueOnce([laptop])
    .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
    .mockReturnValueOnce(new Promise((resolve) => (finishSecond = resolve)));
  await render();
  const refresh = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.click();
  await act(async () => refresh());
  await act(async () => refresh());
  expect(refreshBusy()).toBe("true");
  await act(async () => finishFirst([laptop]));
  expect(refreshBusy()).toBe("true");
  await act(async () => finishSecond([laptop]));
  expect(refreshBusy()).toBe("false");
});

it("resets refreshing on blur and ignores the previous refresh", async () => {
  let finishFirst!: (devices: (typeof laptop)[]) => void;
  let finishSecond!: (devices: (typeof laptop)[]) => void;
  vi.mocked(listUserDevices)
    .mockResolvedValueOnce([laptop])
    .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
    .mockResolvedValueOnce([laptop])
    .mockReturnValueOnce(new Promise((resolve) => (finishSecond = resolve)));
  await render();
  const refresh = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.click();
  await act(async () => refresh());
  await act(async () => blur());
  expect(refreshBusy()).toBe("false");
  await act(async () => focus());
  await act(async () => refresh());
  await act(async () => finishFirst([laptop]));
  expect(refreshBusy()).toBe("true");
  await act(async () => finishSecond([laptop]));
  expect(refreshBusy()).toBe("false");
});

it("ignores a delayed refresh after a successful revoke", async () => {
  let finishRefresh!: (devices: (typeof laptop)[]) => void;
  vi.mocked(listUserDevices)
    .mockResolvedValueOnce([laptop])
    .mockReturnValueOnce(new Promise((resolve) => (finishRefresh = resolve)))
    .mockResolvedValueOnce([]);
  vi.mocked(removeUserDevice).mockResolvedValue();
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.click(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop, Connected"]')?.click(),
  );
  await act(async () => confirmRemove()?.onPress?.());
  await settle();
  await act(async () => finishRefresh([laptop]));
  expect(container.textContent).not.toContain("Laptop");
});

it("filters refresh results while a revoke is pending", async () => {
  let finishRemove!: () => void;
  vi.mocked(listUserDevices).mockResolvedValueOnce([laptop]).mockResolvedValueOnce([laptop]);
  vi.mocked(listUserDevices).mockResolvedValueOnce([]);
  vi.mocked(removeUserDevice).mockReturnValue(new Promise((resolve) => (finishRemove = resolve)));
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop, Connected"]')?.click(),
  );
  await act(async () => confirmRemove()?.onPress?.());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.click(),
  );
  expect(container.textContent).not.toContain("Laptop");
  await act(async () => finishRemove());
  await settle();
  expect(container.textContent).not.toContain("Laptop");
});

it("clears a newer visit's load error when an earlier removal reconciles", async () => {
  let finishRemove!: () => void;
  vi.mocked(listUserDevices)
    .mockResolvedValueOnce([laptop, desk])
    .mockRejectedValueOnce(new Error("list failed"))
    .mockResolvedValueOnce([desk]);
  vi.mocked(removeUserDevice).mockReturnValue(new Promise((resolve) => (finishRemove = resolve)));
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop, Connected"]')?.click(),
  );
  await act(async () => confirmRemove()?.onPress?.());
  await act(async () => {
    blur();
    focus();
  });
  await settle();
  expect(container.textContent).toContain("list failed");
  expect(container.textContent).toContain("Retry");

  await act(async () => finishRemove());
  await settle();
  expect(container.textContent).toContain("Desk PCOffline");
  expect(container.textContent).not.toContain("list failed");
  expect(container.textContent).not.toContain("Retry");
});

it("ignores a previous visit's revoke error after a later removal succeeds", async () => {
  let failFirst!: (error: Error) => void;
  let finishSecond!: () => void;
  vi.mocked(listUserDevices)
    .mockResolvedValueOnce([laptop, desk])
    .mockResolvedValueOnce([laptop, desk])
    .mockResolvedValue([laptop]);
  vi.mocked(removeUserDevice)
    .mockReturnValueOnce(new Promise((_, reject) => (failFirst = reject)))
    .mockReturnValueOnce(new Promise((resolve) => (finishSecond = resolve)));
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Laptop, Connected"]')?.click(),
  );
  await act(async () => confirmRemove()?.onPress?.());
  await act(async () => {
    blur();
    focus();
  });
  await settle();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Desk PC, Offline"]')?.click(),
  );
  await act(async () => confirmRemove()?.onPress?.());
  await act(async () => finishSecond());
  await settle();
  await act(async () => failFirst(new Error("offline")));
  await settle();
  expect(container.textContent).not.toContain("Desk PC");
  expect(container.textContent).not.toContain("offline");
  expect(container.textContent).toContain("LaptopConnected");
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
