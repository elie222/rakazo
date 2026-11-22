// @vitest-environment jsdom

import type { Ticket } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { EffectCallback, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BoardScreen from "../../app/board";
import { queryClient } from "../query/query";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../api/api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async (spaceId: string | null = "space-1") => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => true }));
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
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("./board-list", () => ({
  BoardList: ({
    sections,
    error,
    moving,
    onMove,
    onRefresh,
  }: {
    sections: { tickets: Ticket[] }[];
    error: string;
    moving?: boolean;
    onMove: (ticket: Ticket, status: "done") => void;
    onRefresh: () => Promise<void>;
  }) =>
    createElement(
      "div",
      null,
      sections.flatMap((section) =>
        section.tickets.map((ticket) =>
          createElement("span", { key: ticket.id }, `${ticket.title} ${ticket.status}`),
        ),
      ),
      createElement(
        "button",
        {
          type: "button",
          disabled: moving,
          onClick: () => onMove(sections[0]!.tickets[0]!, "done"),
        },
        "Move",
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
  queryClient.clear();
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((element) => element.textContent === label);
const render = () => act(async () => root.render(createElement(BoardScreen)));

it("retries a failed first load without leaving the screen", async () => {
  const retry = deferred<{ tickets: Ticket[] }>();
  rpc.mockRejectedValueOnce(new Error("Offline")).mockReturnValueOnce(retry.promise);
  await render();
  await vi.waitFor(() => expect(button("Retry")).toBeDefined());
  expect(host.textContent).toContain("Offline");
  await act(async () => button("Retry")?.click());
  await vi.waitFor(() => expect(host.querySelector('[role="progressbar"]')).not.toBeNull());
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.lastCall?.slice(0, 2)).toEqual(["tickets/list", {}]);
  expect(button("Retry")).toBeUndefined();
  await act(async () => retry.resolve({ tickets: [ticket] }));
  await vi.waitFor(() => expect(host.textContent).toContain("Example ticket"));
  expect(host.textContent).not.toContain("Offline");
});

it("allows another retry after the retry fails", async () => {
  rpc
    .mockRejectedValueOnce(new Error("Offline"))
    .mockRejectedValueOnce(new Error("Still offline"))
    .mockResolvedValueOnce({ tickets: [] });
  await render();
  await vi.waitFor(() => expect(button("Retry")).toBeDefined());
  await act(async () => button("Retry")?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Still offline"));
  expect(button("Retry")).toBeDefined();
  await act(async () => button("Retry")?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("No tickets yet."));
  expect(button("Retry")).toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(3);
});

it("keeps the empty state after a successful empty load", async () => {
  rpc.mockResolvedValueOnce({ tickets: [] });
  await render();
  await vi.waitFor(() => expect(host.textContent).toBe("No tickets yet."));
  expect(button("Retry")).toBeUndefined();
});

it("keeps existing tickets available when a refresh fails", async () => {
  rpc.mockResolvedValueOnce({ tickets: [ticket] }).mockRejectedValueOnce(new Error("Offline"));
  await render();
  await vi.waitFor(() => expect(button("Refresh")).toBeDefined());
  await act(async () => button("Refresh")?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("Offline"));
  expect(host.textContent).toContain("Example ticket");
  expect(button("Refresh")).toBeDefined();
  expect(button("Retry")).toBeUndefined();
});

it("shows a moved ticket in its new column", async () => {
  let saved = ticket;
  rpc.mockImplementation(async (proc: string, input: { status?: Ticket["status"] }) => {
    if (proc === "tickets/move") saved = { ...saved, status: input.status! };
    return proc === "tickets/move" ? saved : { tickets: [saved] };
  });
  await render();
  await vi.waitFor(() => expect(button("Move")).toBeDefined());
  await act(async () => button("Move")?.click());
  await vi.waitFor(() => expect(host.textContent).toContain("done"));
  expect(rpc.mock.calls.find(([proc]) => proc === "tickets/move")?.[1]).toEqual({
    id: "ticket-1",
    status: "done",
  });
});

it("offers no other move while one is saving", async () => {
  const first = deferred<Ticket>();
  rpc.mockImplementation(async (proc: string) =>
    proc === "tickets/move" ? first.promise : { tickets: [ticket] },
  );
  await render();
  await vi.waitFor(() => expect(button("Move")).toBeDefined());
  await act(async () => button("Move")?.click());
  expect(button("Move")?.disabled).toBe(true);
  await act(async () => first.resolve({ ...ticket, status: "done" }));
  await vi.waitFor(() => expect(button("Move")?.disabled).toBe(false));
});
