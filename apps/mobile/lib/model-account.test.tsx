// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelAccount } from "../components/model-account";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  balance: vi.fn(),
  openAuthSessionAsync: vi.fn(),
  continueWithSso: vi.fn(),
  t: (text: string) => text,
}));
vi.mock("@rakazo/core", async (original) => ({
  ...(await original<object>()),
  createModelAccountClient: () => ({
    config: async () => ({ enabled: true }),
    status: mocks.status,
    connect: mocks.connect,
    balance: mocks.balance,
  }),
}));
vi.mock("./api/api", () => ({
  authHeaders: async () => ({}),
  currentApiBase: () => "https://app.example.test",
}));
vi.mock("./api/server-headers", () => ({ fetchServer: vi.fn() }));
vi.mock("./auth/sso", () => ({ continueWithSso: mocks.continueWithSso }));
vi.mock("./api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./i18n/i18n", () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => () => void) => useEffect(callback, [callback]),
}));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: mocks.openAuthSessionAsync }));
vi.mock("react-native", () => ({
  ActivityIndicator: () => <span role="progressbar" />,
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock("../components/ui/menu-picker", () => ({ MenuPickerMenu: () => null }));
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
  SettingsRow: ({
    title,
    disabled,
    onPress,
  }: {
    title: string;
    disabled?: boolean;
    onPress?: () => void;
  }) =>
    onPress ? (
      <button type="button" disabled={disabled} onClick={onPress}>
        {title}
      </button>
    ) : null,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({
    enabled: true,
    linked: true,
    connected: false,
    recovery: "authorization_required",
  });
  mocks.balance.mockResolvedValue({ amount: "1.00", unit: "USD" });
  mocks.openAuthSessionAsync.mockResolvedValue({ type: "cancel" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("refreshes account settings after an uncertain authorization is recovered without opening a browser", async () => {
  mocks.status.mockResolvedValue({
    enabled: true,
    linked: true,
    connected: false,
    recovery: "authorization_unknown",
  });
  const changed = vi.fn();
  await act(async () => root.render(<ModelAccount onChanged={changed} />));
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("Retry");
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.openAuthSessionAsync).not.toHaveBeenCalled();
  mocks.status.mockResolvedValue({ enabled: true, linked: true, connected: true });
  await act(async () => button.click());
  expect(changed).toHaveBeenCalledOnce();
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.openAuthSessionAsync).not.toHaveBeenCalled();
});

it("does not open authorization when its request returns after account settings unmount", async () => {
  let resolve!: (value: { connected: boolean; url: string }) => void;
  mocks.connect.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const changed = vi.fn();
  await act(async () => root.render(<ModelAccount onChanged={changed} />));
  await act(async () => container.querySelector("button")!.click());
  const signal = mocks.connect.mock.calls[0]![1] as AbortSignal;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  await act(async () =>
    resolve({ connected: false, url: "https://gateway.example.test/authorize" }),
  );
  expect(mocks.openAuthSessionAsync).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("links the existing account directly and then offers model authorization", async () => {
  mocks.status.mockResolvedValue({ enabled: true, linked: false, connected: false });
  const changed = vi.fn();
  await act(async () => root.render(<ModelAccount onChanged={changed} />));
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.startsWith("Continue with"),
  )!;
  expect(button).toBeDefined();
  mocks.continueWithSso.mockResolvedValue(true);
  mocks.status.mockResolvedValue({ enabled: true, linked: true, connected: false });
  await act(async () => button.click());
  expect(mocks.continueWithSso).toHaveBeenCalledWith("link");
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Agree and authorize");
});

it("keeps first authorization focused and shows pending feedback without fetching balance", async () => {
  mocks.status.mockResolvedValue({ enabled: true, linked: true, connected: false });
  let finish!: (value: { connected: boolean }) => void;
  mocks.connect.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const changed = vi.fn();
  await act(async () => root.render(<ModelAccount onChanged={changed} />));
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "Agree and authorize",
  ]);
  expect(mocks.balance).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("button")!.disabled).toBe(true);
  expect(container.textContent).toContain("Authorizing…");
  expect(mocks.connect).toHaveBeenCalledOnce();
  mocks.status.mockResolvedValue({ enabled: true, linked: true, connected: true });
  await act(async () => finish({ connected: true }));
  expect(changed).toHaveBeenCalledOnce();
  expect(mocks.balance).not.toHaveBeenCalled();
});
