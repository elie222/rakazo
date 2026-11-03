// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WalletSettings from "../app/(settings)/wallet";

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  openURL: vi.fn(async () => true),
  alert: vi.fn(),
  t: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? "")),
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(callback, [callback]);
  },
}));
vi.mock("./api", () => ({
  rpc: (method: string) => {
    if (method === "me") return mocks.me();
    if (method === "paymentWallet/status") return mocks.status();
    if (method === "paymentWallet/connect") return mocks.connect();
    if (method === "paymentWallet/disconnect") return mocks.disconnect();
    throw new Error(`Unexpected ${method}`);
  },
}));
vi.mock("./i18n", () => ({ t: mocks.t, useI18n: () => ({ t: mocks.t }) }));
vi.mock("../components/load-failure", () => ({
  LoadFailure: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    value,
    onPress,
    disabled,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    onPress ? (
      <button type="button" disabled={disabled} onClick={onPress}>
        {title}
      </button>
    ) : (
      <p>
        {title}
        {value ? <span data-testid="value">{value}</span> : null}
      </p>
    ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Alert: { alert: mocks.alert },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Linking: { openURL: mocks.openURL },
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

const connecting = {
  status: "connecting" as const,
  verificationUrl: "https://wallet.example.test/connect/abc",
  userCode: "WXYZ-1234",
  expiresAt: "2026-10-27T12:15:00.000Z",
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.me.mockResolvedValue({ paymentWalletProvider: { id: "link", name: "Link" } });
  mocks.status.mockResolvedValue({ status: "disconnected" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render() {
  await act(async () => root.render(<WalletSettings />));
  await act(async () => vi.advanceTimersByTimeAsync(0));
}
function button(label: string) {
  const match = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}
const code = () => container.querySelector('[data-testid="value"]')?.textContent ?? null;

it("connects with a code, polls until connected, and disconnects after a native confirm", async () => {
  mocks.connect.mockResolvedValue(connecting);
  await render();

  await act(async () => button("Connect Link").click());
  expect(mocks.openURL).toHaveBeenCalledWith(connecting.verificationUrl);
  expect(code()).toBe("WXYZ-1234");

  mocks.status.mockResolvedValue(connecting);
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(code()).toBe("WXYZ-1234");
  await act(async () => button("Open").click());
  expect(mocks.openURL).toHaveBeenCalledTimes(2);

  mocks.status.mockResolvedValue({ status: "connected", connectedAt: "2026-10-27T12:01:00Z" });
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(code()).toBeNull();
  expect(container.textContent).toContain("Link");

  // Settled: no more reads.
  const reads = mocks.status.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mocks.status).toHaveBeenCalledTimes(reads);

  mocks.disconnect.mockResolvedValue({ status: "disconnected" });
  await act(async () => button("Disconnect").click());
  expect(mocks.disconnect).not.toHaveBeenCalled();
  const [title, , buttons] = mocks.alert.mock.calls[0] as [
    string,
    undefined,
    { text: string; style: string; onPress?: () => void }[],
  ];
  expect(title).toBe("Disconnect Link?");
  const confirm = buttons.find((choice) => choice.style === "destructive");
  await act(async () => confirm?.onPress?.());
  expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  expect(button("Connect Link")).toBeTruthy();
});

it("cancels an open sign-in", async () => {
  mocks.status.mockResolvedValue(connecting);
  mocks.disconnect.mockResolvedValue({ status: "disconnected" });
  await render();
  expect(code()).toBe("WXYZ-1234");
  await act(async () => button("Cancel").click());
  expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  expect(button("Connect Link")).toBeTruthy();
});

it("shows nothing to connect when the deployment has no wallet", async () => {
  mocks.me.mockResolvedValue({ paymentWalletProvider: null });
  await render();
  expect(container.querySelectorAll("button")).toHaveLength(0);
});
