// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpendingLimitSettings from "../app/(settings)/spending-limit";

const mocks = vi.hoisted(() => ({
  focused: true,
  get: vi.fn(),
  set: vi.fn(),
  payments: vi.fn(),
  alert: vi.fn(),
  prompt: vi.fn(),
  platform: { OS: "ios" },
  t: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? "")),
}));
vi.mock("./i18n", () => ({ useUiLocale: () => "en", dateLocaleForUi: () => "en-US" }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native", () => ({ native: {} }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(() => (mocks.focused ? callback() : undefined), [callback, mocks.focused]);
  },
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc: (method: string, body: unknown) => {
    if (method === "spendingLimit/get") return mocks.get();
    if (method === "spendingLimit/set") return mocks.set(body);
    if (method === "spendingLimit/payments") return mocks.payments();
    throw new Error(`Unexpected ${method}`);
  },
}));
vi.mock("../components/load-failure", () => ({
  LoadFailure: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
    <div>
      <p role="alert">{message}</p>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  ),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/name-dialog", () => ({ TextFieldDialog: () => null }));
// The native menu as one button per choice, named by the menu and the choice.
vi.mock("../components/menu-picker", () => ({
  MenuPickerMenu: ({
    label,
    choices,
    onChange,
  }: {
    label: string;
    choices: Array<{ key: string; label: string }>;
    onChange: (key: string) => void;
  }) => (
    <div>
      {choices.map((choice) => (
        <button key={choice.key} type="button" onClick={() => onChange(choice.key)}>
          {`${label}: ${choice.label}`}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../components/settings-group", () => ({
  useStackedSettings: () => false,
  SettingsGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    value,
    detail,
    onPress,
  }: {
    title: string;
    value?: string;
    detail?: string;
    onPress?: () => void;
  }) => (
    <button type="button" onClick={onPress}>
      {[title, value, detail].filter(Boolean).join(" | ")}
    </button>
  ),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Platform: mocks.platform,
    Alert: { alert: mocks.alert, prompt: mocks.prompt },
    StyleSheet: { create: (styles: unknown) => styles },
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.focused = true;
  mocks.get.mockReset();
  mocks.payments.mockReset();
  mocks.payments.mockResolvedValue([]);
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
  await act(async () => root.render(<SpendingLimitSettings />));
}
function button(text: string) {
  const match = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith(text),
  );
  if (!match) throw new Error(`Missing ${text} in ${container.textContent}`);
  return match;
}
/** Answers the system prompt the amount row opens. */
function enter(text: string) {
  const [, , buttons] = mocks.prompt.mock.calls.at(-1)!;
  return (buttons as Array<{ text: string; onPress?: (value: string) => void }>).find(
    (entry) => entry.text === "Save",
  )!.onPress!(text);
}

it("sets a limit from the amount, then changes how often it resets, and removes it", async () => {
  mocks.get.mockResolvedValue({ limit: null, spent: 0, shown: true });
  const monthly = { amount: 20_000, currency: "usd", period: "month" };
  mocks.set.mockResolvedValueOnce({ limit: monthly, spent: 2_340, shown: true });
  await render();
  expect(button("Amount").textContent).toBe("Amount | None");
  expect(container.textContent).not.toContain("Resets");

  await act(async () => button("Amount").click());
  expect(mocks.prompt).toHaveBeenCalledWith(
    "Spending limit",
    undefined,
    expect.any(Array),
    "plain-text",
    "",
    "decimal-pad",
  );
  await act(async () => enter("200"));
  expect(mocks.set).toHaveBeenLastCalledWith({ limit: monthly });
  expect(button("Amount").textContent).toBe("Amount | $200.00 | $23.40 spent this month");

  const weekly = { ...monthly, period: "week" };
  mocks.set.mockResolvedValueOnce({ limit: weekly, spent: 0, shown: true });
  await act(async () => button("Resets: Weekly").click());
  expect(mocks.set).toHaveBeenLastCalledWith({ limit: weekly });
  expect(button("Amount").textContent).toBe("Amount | $200.00 | $0.00 spent this week");

  mocks.set.mockResolvedValueOnce({ limit: null, spent: 0, shown: true });
  await act(async () => button("Remove").click());
  expect(mocks.set).toHaveBeenLastCalledWith({ limit: null });
  expect(button("Amount").textContent).toBe("Amount | None");
});

it("refuses an amount that isn't one, without saving", async () => {
  mocks.get.mockResolvedValue({ limit: null, spent: 0, shown: true });
  await render();
  await act(async () => button("Amount").click());
  await act(async () => enter("abc"));
  expect(mocks.alert).toHaveBeenCalledWith("Enter an amount");
  expect(mocks.set).not.toHaveBeenCalled();
});

it("lists the payments that count under the limit", async () => {
  mocks.get.mockResolvedValue({ limit: null, spent: 0, shown: true });
  mocks.payments.mockResolvedValue([
    {
      id: "payment-1",
      site: "shop.example.test",
      amount: 2_340,
      currency: "usd",
      botName: "Shopper",
      createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    },
    {
      id: "payment-2",
      site: "other.example.test",
      amount: 500,
      currency: "eur",
      botName: null,
      createdAt: new Date(Date.now() - 30_000).toISOString(),
    },
  ]);
  await render();
  expect(button("shop.example.test").textContent).toBe(
    "shop.example.test | $23.40 | Shopper · 2h ago",
  );
  expect(button("other.example.test").textContent).toBe("other.example.test | €5.00 | just now");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const currentStatus = {
  limit: { amount: 20_000, currency: "usd", period: "month" },
  spent: 2340,
  shown: true,
};
const oldStatus = {
  limit: { amount: 10_000, currency: "usd", period: "month" },
  spent: 100,
  shown: true,
};

async function retryTwice() {
  mocks.get.mockRejectedValueOnce(new Error("Initial failure"));
  await render();
  const older = deferred<typeof currentStatus>();
  const newer = deferred<typeof currentStatus>();
  mocks.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  await act(async () => {
    button("Retry").click();
    button("Retry").click();
  });
  return { older, newer };
}

it("keeps the latest limit and spent amount when an older retry succeeds later", async () => {
  const { older, newer } = await retryTwice();
  await act(async () => newer.resolve(currentStatus));
  await act(async () => older.resolve(oldStatus));
  expect(button("Amount").textContent).toBe("Amount | $200.00 | $23.40 spent this month");
});

it("keeps the latest retry error when an older retry succeeds later", async () => {
  const { older, newer } = await retryTwice();
  await act(async () => newer.reject(new Error("Latest failure")));
  await act(async () => older.resolve(oldStatus));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Latest failure");
  expect(container.textContent).not.toContain("Amount");
});

it("keeps the latest retry error when an older retry fails later", async () => {
  const { older, newer } = await retryTwice();
  await act(async () => newer.reject(new Error("Latest failure")));
  await act(async () => older.reject(new Error("Old failure")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Latest failure");
});

it("ignores reads completed after blur, including across refocus", async () => {
  const older = deferred<typeof currentStatus>();
  const newer = deferred<typeof currentStatus>();
  mocks.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  await render();
  mocks.focused = false;
  await render();
  await act(async () => older.resolve(oldStatus));
  expect(container.textContent).not.toContain("Amount");
  mocks.focused = true;
  await render();
  await act(async () => newer.resolve(currentStatus));
  expect(button("Amount").textContent).toBe("Amount | $200.00 | $23.40 spent this month");
});

it("keeps a saved limit when an earlier read completes", async () => {
  mocks.get.mockResolvedValueOnce(currentStatus);
  await render();
  mocks.focused = false;
  await render();
  const older = deferred<typeof currentStatus>();
  mocks.get.mockReturnValueOnce(older.promise);
  mocks.focused = true;
  await render();
  mocks.set.mockResolvedValueOnce({ limit: null, spent: 0, shown: true });
  await act(async () => button("Remove").click());
  await act(async () => older.resolve(oldStatus));
  expect(button("Amount").textContent).toBe("Amount | None");
});
