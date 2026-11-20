// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PagesScreen from "../../app/pages";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../api/api", () => ({ rpc }));
vi.mock("@lingui/core/macro", () => ({ ph: (value: unknown) => value }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts[0] }),
}));
vi.mock("@rakazo/chat-ui/native", () => ({ PageIcon: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ botId: "bot-1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ActivityIndicator: () => <div role="progressbar" />,
    Alert: { alert: vi.fn() },
    ScrollView: View,
    StyleSheet: { create: (styles: unknown) => styles },
    Text: ({
      accessibilityRole,
      children,
    }: {
      accessibilityRole?: string;
      children?: ReactNode;
    }) => <span role={accessibilityRole}>{children}</span>,
    View,
  };
});
vi.mock("../../components/bots/profile-edit-dialog", () => ({
  useTextEditDialog: () => ({ ask: vi.fn(), dialog: null }),
}));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ title, onPress }: { title: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock("../../components/ui/long-press-menu", () => ({
  LongPressMenu: ({
    children,
    title,
    onPressAction,
  }: {
    children: (onLongPress: () => void) => ReactNode;
    title: string;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {children(() => undefined)}
      <button type="button" onClick={() => onPressAction({ nativeEvent: { event: "pin" } })}>
        Pin {title}
      </button>
    </div>
  ),
}));
vi.mock("../inbox/activity", () => ({ formatActivityRelativeTime: () => "now" }));
vi.mock("../native/native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("./pages", () => ({
  getLatestPage: vi.fn(),
  pageLoadProblem: () => "failed",
  removePage: vi.fn(),
  renamePage: vi.fn(),
}));

const page = (id: string, title: string) => ({
  id,
  title,
  pinned: false,
  visibility: "private",
  updatedAt: "2026-01-01T00:00:00Z",
});
const first = page("p1", "First page");
const second = page("p2", "Second page");
const firstRead = { items: [first], nextCursor: "next-cursor" };
const lastRead = { items: [second], nextCursor: null };
const nextInput = { botId: "bot-1", cursor: "next-cursor", limit: 5 };
const pagingError = "Could not load pages.";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpc.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<PagesScreen />));
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((node) => node.textContent === label);
const alert = () => host.querySelector('[role="alert"]')?.textContent;
const tap = (label: string) => act(async () => button(label)?.click());

it("clears a failed next-page alert on retry, reuses the cursor, and keeps the loaded pages", async () => {
  const retry = deferred<typeof lastRead>();
  rpc.mockResolvedValueOnce(firstRead).mockRejectedValueOnce(new Error("offline"));
  await render();
  await tap("Show more");
  expect(button("First page")).toBeDefined();
  expect(alert()).toBe(pagingError);

  rpc.mockReturnValueOnce(retry.promise);
  await act(async () => {
    button("Show more")?.click();
    button("Show more")?.click();
  });
  expect(rpc.mock.calls.slice(1)).toEqual([
    ["pages/list", nextInput],
    ["pages/list", nextInput],
  ]);
  expect(button("First page")).toBeDefined();
  const retryAlert = alert();

  await act(async () => retry.resolve(lastRead));
  expect(button("First page")).toBeDefined();
  expect(button("Second page")).toBeDefined();
  expect(button("Show more")).toBeUndefined();
  expect(alert()).toBeUndefined();
  expect(retryAlert).toBeUndefined();
});

it("shows the error again if the next-page retry also fails", async () => {
  rpc.mockResolvedValueOnce(firstRead).mockRejectedValue(new Error("offline"));
  await render();
  await tap("Show more");
  await tap("Show more");
  expect(rpc).toHaveBeenCalledTimes(3);
  expect(rpc).toHaveBeenLastCalledWith("pages/list", nextInput);
  expect(alert()).toBe(pagingError);
  expect(button("First page")).toBeDefined();
  expect(button("Show more")).toBeDefined();
});

it("keeps the dedicated first-read retry and does not add a cursor to it", async () => {
  rpc.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(firstRead);
  await render();
  expect(alert()).toBe(pagingError);
  expect(button("Show more")).toBeUndefined();
  expect(button("Try again")).toBeDefined();

  await tap("Try again");
  expect(rpc.mock.calls).toEqual([
    ["pages/list", { botId: "bot-1", limit: 5 }],
    ["pages/list", { botId: "bot-1", limit: 5 }],
  ]);
  expect(button("First page")).toBeDefined();
  expect(alert()).toBeUndefined();
});

it("does not clear an unrelated page action error on pagination", async () => {
  rpc
    .mockResolvedValueOnce(firstRead)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(firstRead)
    .mockResolvedValueOnce(lastRead);
  await render();
  await tap("Pin First page");
  expect(rpc).toHaveBeenNthCalledWith(2, "pages/pin", { pageId: first.id, pinned: true });
  expect(alert()).toBe("Could not pin the page.");

  await tap("Show more");
  expect(rpc).toHaveBeenLastCalledWith("pages/list", nextInput);
  expect(button("Second page")).toBeDefined();
  expect(alert()).toBe("Could not pin the page.");
});
