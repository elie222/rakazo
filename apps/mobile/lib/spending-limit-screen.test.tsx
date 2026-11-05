// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SpendingLimitSettings from "../app/(settings)/spending-limit";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  alert: vi.fn(),
  prompt: vi.fn(),
  platform: { OS: "ios" },
  t: (text: string, values?: Record<string, unknown>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? "")),
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native", () => ({ native: {} }));
vi.mock("expo-router", () => ({
  useFocusEffect: (callback: () => undefined | (() => void)) => {
    useEffect(callback, [callback]);
  },
}));
vi.mock("./api", () => ({
  rpc: (method: string, body: unknown) => {
    if (method === "spendingLimit/get") return mocks.get();
    if (method === "spendingLimit/set") return mocks.set(body);
    throw new Error(`Unexpected ${method}`);
  },
}));
vi.mock("./i18n", () => ({
  t: mocks.t,
  useI18n: () => ({ t: mocks.t, locale: "en" }),
  dateLocaleForUi: () => "en-US",
}));
vi.mock("../components/load-failure", () => ({
  LoadFailure: ({ message }: { message: string }) => <p role="alert">{message}</p>,
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
