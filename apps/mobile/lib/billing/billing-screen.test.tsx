// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BillingScreen from "../../app/(settings)/billing";
import { queryClient } from "../query/query";

const mocks = vi.hoisted(() => ({
  selectedSpace: "space-1",
  focused: true,
  locale: "en-US",
  rpc: vi.fn(),
  alert: vi.fn(),
  openAuthSessionAsync: vi.fn(async () => ({ type: "dismiss" })),
}));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../i18n/i18n", () => ({ dateLocaleForUi: () => mocks.locale }));
vi.mock("./referral", () => ({ rememberReferral: vi.fn() }));
vi.mock("../settings/settings-sheet", () => ({ openFromSettingsSheet: vi.fn() }));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: mocks.openAuthSessionAsync }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useIsFocused: () => mocks.focused,
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(() => callback(), [callback]);
  },
}));
vi.mock("../api/api", () => ({
  rpc: mocks.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => mocks.selectedSpace,
  captureApiRequestContext: async (spaceId: string | null = mocks.selectedSpace) => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
        {value == null ? null : ` ${value}`}
      </p>
    ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ScrollView: View,
    Alert: { alert: mocks.alert },
    Linking: { openURL: vi.fn() },
    Share: { share: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

const status = {
  state: "active",
  access: true,
  canManage: true,
  hasCustomer: true,
  funding: "credits",
  balanceUsd: 0,
  monthlyAmountCents: null,
  creditPurchasesEnabled: true,
  referral: null,
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  mocks.selectedSpace = "space-1";
  mocks.focused = true;
  mocks.locale = "en-US";
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

async function render() {
  await act(async () => root.render(<BillingScreen />));
}
function button(label: string) {
  const match = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}
const sent = (method: string) => mocks.rpc.mock.calls.filter(([name]) => name === method);

it.each([
  ["de-DE", 1234.5, "1.234,50\u00a0$"],
  ["en-US", 1234.5, "$1,234.50"],
  ["de-DE", undefined, "0,00\u00a0$"],
])("formats available credits in %s for %s", async (locale, balanceUsd, amount) => {
  mocks.locale = locale;
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "billing/status") return { ...status, balanceUsd };
    throw new Error(`Unexpected ${method}`);
  });

  await render();

  const rows = [...container.querySelectorAll("p")].map((row) => row.textContent);
  expect(rows).toContain(`Available credits ${amount}`);
});

it("opens the portal once for a double tap and refreshes the status in the Space it opened in", async () => {
  const portal = deferred<{ url: string }>();
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "billing/status") return status;
    if (method === "billing/portal") return portal.promise;
    if (method === "billing/refresh") return { ...status, balanceUsd: 5 };
    throw new Error(`Unexpected ${method}`);
  });
  await render();
  await act(async () => {
    button("Manage billing").click();
    button("Manage billing").click();
  });
  expect(button("Manage billing").disabled).toBe(true);
  await act(async () => portal.resolve({ url: "https://billing.example.test/portal" }));
  await vi.waitFor(() => expect(sent("billing/refresh")).toHaveLength(1));
  expect(sent("billing/portal")).toHaveLength(1);
  expect(mocks.openAuthSessionAsync).toHaveBeenCalledTimes(1);
  const [, , options] = sent("billing/refresh")[0] ?? [];
  expect(options.requestContext.headers["x-rakazo-space-id"]).toBe("space-1");
  await vi.waitFor(() => expect(container.textContent).toContain("Available credits"));
  expect(button("Manage billing").disabled).toBe(false);
});

it("says the card was not charged when the server refuses payment", async () => {
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "billing/status") return status;
    throw Object.assign(new Error("Payment required"), { status: 402 });
  });
  await render();
  await act(async () => button("Manage billing").click());
  await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledWith("Your card was not charged"));
  expect(button("Manage billing").disabled).toBe(false);
});

it("does not alert over another page when the status read fails after leaving", async () => {
  const read = deferred<typeof status>();
  mocks.rpc.mockImplementation(async (method: string) => {
    if (method === "billing/status") return read.promise;
    throw new Error(`Unexpected ${method}`);
  });
  await render();
  mocks.focused = false;
  await render();
  await act(async () => read.reject(new Error("offline")));
  await act(async () => queryClient.cancelQueries());
  expect(mocks.alert).not.toHaveBeenCalled();
});
