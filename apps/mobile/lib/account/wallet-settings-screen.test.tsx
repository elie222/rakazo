// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WalletSettings from "../../app/(settings)/wallet";
import { queryClient } from "../query/query";

const mocks = vi.hoisted(() => ({
  focused: true,
  foreground: true,
  selectedSpace: "space-1",
  me: vi.fn(),
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  openURL: vi.fn(async () => true),
  alert: vi.fn(),
  t: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? "")),
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(() => (mocks.focused ? callback() : undefined), [callback, mocks.focused]);
  },
}));
vi.mock("../api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => mocks.selectedSpace,
  captureApiRequestContext: async (spaceId: string | null = mocks.selectedSpace) => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
  rpc: (method: string) => {
    if (method === "me") return mocks.me();
    if (method === "paymentWallet/status") return mocks.status();
    if (method === "paymentWallet/connect") return mocks.connect();
    if (method === "paymentWallet/disconnect") return mocks.disconnect();
    throw new Error(`Unexpected ${method}`);
  },
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => mocks.foreground }));
vi.mock("../../components/ui/load-failure", () => ({
  LoadFailure: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
    <div>
      <p role="alert">{message}</p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  ),
}));
vi.mock("../../components/settings/settings-group", () => ({
  useStackedSettings: () => false,
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

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  mocks.focused = true;
  mocks.foreground = true;
  mocks.selectedSpace = "space-1";
  mocks.me.mockReset();
  mocks.status.mockReset();
  mocks.connect.mockReset();
  mocks.disconnect.mockReset();
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

const disconnected = { status: "disconnected" as const };
const connected = { status: "connected" as const, connectedAt: "2026-10-27T12:01:00Z" };
const failure = () => container.querySelector('[role="alert"]')?.textContent ?? null;

it("connects once when Connect is tapped twice in one tick, and holds the rows meanwhile", async () => {
  const answer = deferred<typeof connecting>();
  mocks.connect.mockReturnValue(answer.promise);
  await render();
  await act(async () => {
    button("Connect Link").click();
    button("Connect Link").click();
  });
  expect(mocks.connect).toHaveBeenCalledOnce();
  expect(button("Connect Link").disabled).toBe(true);
  await act(async () => answer.resolve(connecting));
  expect(mocks.openURL).toHaveBeenCalledOnce();
  expect(button("Cancel").disabled).toBe(false);
});

it("says so in an alert when a change fails, and takes the next one", async () => {
  mocks.connect.mockRejectedValueOnce(new Error("Wallet refused"));
  await render();
  await act(async () => button("Connect Link").click());
  expect(mocks.alert).toHaveBeenCalledWith("Wallet refused");
  expect(button("Connect Link").disabled).toBe(false);
  mocks.connect.mockResolvedValueOnce(connecting);
  await act(async () => button("Connect Link").click());
  expect(code()).toBe("WXYZ-1234");
});

it("keeps a change when a read that started before it answers later", async () => {
  mocks.status.mockResolvedValueOnce(connecting);
  await render();
  const older = deferred<typeof connecting>();
  mocks.status.mockReturnValueOnce(older.promise);
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  mocks.disconnect.mockResolvedValue(disconnected);
  await act(async () => button("Cancel").click());
  await act(async () => older.resolve(connecting));
  expect(code()).toBeNull();
  expect(button("Connect Link")).toBeTruthy();
});

it("reports a change for the account, whichever space is selected by the time it answers", async () => {
  await render();
  const answer = deferred<typeof connecting>();
  mocks.connect.mockReturnValueOnce(answer.promise);
  await act(async () => button("Connect Link").click());
  mocks.selectedSpace = "space-2";
  await render();
  // The wallet is the account's: another space neither reads it again nor frees the rows.
  expect(mocks.status).toHaveBeenCalledOnce();
  expect(button("Connect Link").disabled).toBe(true);
  await act(async () => answer.reject(new Error("Wallet refused")));
  expect(mocks.alert).toHaveBeenCalledWith("Wallet refused");
});

it("reads the wallet again on a later visit instead of showing the earlier copy", async () => {
  mocks.status.mockResolvedValueOnce(connected);
  await render();
  expect(button("Disconnect")).toBeTruthy();
  await act(async () => root.unmount());
  root = createRoot(container);
  const later = deferred<typeof disconnected>();
  mocks.status.mockReturnValueOnce(later.promise);
  await render();
  expect(container.querySelectorAll("button")).toHaveLength(0);
  await act(async () => later.resolve(disconnected));
  expect(button("Connect Link")).toBeTruthy();
});

it("reads again on return to the screen and to the app, which finishes a sign-in", async () => {
  mocks.status.mockResolvedValueOnce(connecting);
  await render();
  expect(mocks.status).toHaveBeenCalledTimes(1);
  mocks.foreground = false;
  await render();
  mocks.status.mockResolvedValueOnce(connected);
  mocks.foreground = true;
  await render();
  expect(mocks.status).toHaveBeenCalledTimes(2);
  expect(mocks.me).toHaveBeenCalledTimes(2);
  expect(button("Disconnect")).toBeTruthy();
  mocks.focused = false;
  await render();
  mocks.focused = true;
  await render();
  expect(mocks.status).toHaveBeenCalledTimes(3);
});

it("stops asking about an open sign-in while another screen covers this one", async () => {
  mocks.status.mockResolvedValue(connecting);
  await render();
  mocks.focused = false;
  await render();
  const reads = mocks.status.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mocks.status).toHaveBeenCalledTimes(reads);
});

it("keeps an open sign-in on screen, with no alert, when one of its checks fails", async () => {
  mocks.status.mockResolvedValueOnce(connecting);
  await render();
  mocks.status.mockRejectedValueOnce(new Error("Offline"));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(code()).toBe("WXYZ-1234");
  expect(failure()).toBeNull();
  expect(mocks.alert).not.toHaveBeenCalled();
  mocks.status.mockResolvedValueOnce(connected);
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(button("Disconnect")).toBeTruthy();
});

it.each(["me", "status"] as const)(
  "offers a retry when the %s read fails, and keeps the failure up until the retry answers",
  async (read) => {
    mocks[read].mockRejectedValueOnce(new Error("Offline"));
    await render();
    expect(failure()).toBe("Offline");
    expect(container.textContent).not.toContain("Connect Link");
    const retry = deferred<unknown>();
    mocks[read].mockReturnValueOnce(retry.promise);
    await act(async () => button("Retry").click());
    expect(failure()).toBe("Offline");
    await act(async () =>
      retry.resolve(
        read === "me" ? { paymentWalletProvider: { id: "link", name: "Link" } } : disconnected,
      ),
    );
    expect(failure()).toBeNull();
    expect(button("Connect Link")).toBeTruthy();
  },
);
