// @vitest-environment jsdom

import type { Ticket } from "@rakazo/contracts";
import type { EffectCallback, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BoardScreen from "../app/board";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./api", () => ({ rpc }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => createElement("div", { role: "progressbar" }),
  Alert: { alert: vi.fn() },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/board-list", () => ({
  BoardList: ({
    sections,
    error,
    onRefresh,
  }: {
    sections: { tickets: Ticket[] }[];
    error: string;
    onRefresh: () => Promise<void>;
  }) =>
    createElement(
      "div",
      null,
      sections.flatMap((section) =>
        section.tickets.map((ticket) => createElement("span", { key: ticket.id }, ticket.title)),
      ),
      error,
      createElement("button", { type: "button", onClick: () => void onRefresh() }, "Refresh"),
    ),
}));

const ticket = {
  id: "ticket-1",
  title: "Example ticket",
  status: "todo",
} as Ticket;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  rpc.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((element) => element.textContent === label);
const render = () => act(async () => root.render(createElement(BoardScreen)));
function deferred() {
  let resolve!: (value: { tickets: Ticket[] }) => void;
  const promise = new Promise<{ tickets: Ticket[] }>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it("retries a failed first load without leaving the screen", async () => {
  const retry = deferred();
  rpc.mockRejectedValueOnce(new Error("Offline")).mockReturnValueOnce(retry.promise);
  await render();
  expect(host.textContent).toContain("Offline");
  expect(button("Retry")).toBeDefined();
  await act(async () => button("Retry")?.click());
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenLastCalledWith("tickets/list", {});
  expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(button("Retry")).toBeUndefined();
  await act(async () => retry.resolve({ tickets: [ticket] }));
  expect(host.textContent).toContain("Example ticket");
  expect(host.textContent).not.toContain("Offline");
});

it("allows another retry after the retry fails", async () => {
  rpc
    .mockRejectedValueOnce(new Error("Offline"))
    .mockRejectedValueOnce(new Error("Still offline"))
    .mockResolvedValueOnce({ tickets: [] });
  await render();
  await act(async () => button("Retry")?.click());
  expect(host.textContent).toContain("Still offline");
  expect(button("Retry")).toBeDefined();
  await act(async () => button("Retry")?.click());
  expect(host.textContent).toContain("No tickets yet.");
  expect(button("Retry")).toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(3);
});

it("keeps the empty state after a successful empty load", async () => {
  rpc.mockResolvedValueOnce({ tickets: [] });
  await render();
  expect(host.textContent).toBe("No tickets yet.");
  expect(button("Retry")).toBeUndefined();
});

it("keeps existing tickets available when a refresh fails", async () => {
  rpc.mockResolvedValueOnce({ tickets: [ticket] }).mockRejectedValueOnce(new Error("Offline"));
  await render();
  await act(async () => button("Refresh")?.click());
  expect(host.textContent).toContain("Example ticket");
  expect(host.textContent).toContain("Offline");
  expect(button("Refresh")).toBeDefined();
  expect(button("Retry")).toBeUndefined();
});
