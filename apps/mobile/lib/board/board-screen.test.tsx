// @vitest-environment jsdom

import type { Ticket } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { EffectCallback, ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BoardScreen from "../../app/board";
import { queryClient } from "../query/query";

const state = vi.hoisted(() => ({ rpc: vi.fn(), foreground: true }));
const { rpc } = state;
vi.mock("../api/api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async (spaceId: string | null = "space-1") => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("../api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../platform/app-foreground", () => ({ useAppForeground: () => state.foreground }));
vi.mock("../settings/back-to-settings", () => ({ useBackToSettings: () => undefined }));
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
  NativeActionButton: ({
    label,
    onPress,
    busy,
  }: {
    label: string;
    onPress: () => void;
    busy?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", "aria-label": label, onClick: onPress, disabled: busy },
      busy ? createElement("span", { role: "progressbar" }) : label,
    ),
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.foreground = true;
  rpc.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === label,
  );
const render = () => act(async () => root.render(createElement(BoardScreen)));

it("retries a failed first load without leaving the screen", async () => {
  const retry = deferred<{ tickets: Ticket[] }>();
  rpc.mockRejectedValueOnce(new Error("Offline")).mockReturnValueOnce(retry.promise);
  await render();
  await vi.waitFor(() => expect(button("Retry")).toBeDefined());
  expect(host.textContent).toContain("Offline");
  expect(button("Refresh")).toBeUndefined();
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

it("refreshes an empty board to show the first ticket without leaving", async () => {
  const refresh = deferred<{ tickets: Ticket[] }>();
  rpc.mockResolvedValueOnce({ tickets: [] }).mockReturnValueOnce(refresh.promise);
  await render();
  await vi.waitFor(() => expect(button("Refresh")).toBeDefined());
  expect(host.textContent).toContain("No tickets yet.");
  expect(button("Retry")).toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(1);

  await act(async () => button("Refresh")?.click());
  await vi.waitFor(() => expect(host.querySelector('[role="progressbar"]')).not.toBeNull());
  expect(host.textContent).toContain("No tickets yet.");
  expect(button("Refresh")?.disabled).toBe(true);
  await act(async () => button("Refresh")?.click());
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.lastCall?.slice(0, 2)).toEqual(["tickets/list", {}]);

  await act(async () => refresh.resolve({ tickets: [ticket] }));
  await vi.waitFor(() => expect(host.textContent).toContain("Example ticket"));
  expect(host.textContent).not.toContain("No tickets yet.");
});

it("keeps the cached empty board visible during a foreground refetch", async () => {
  const refresh = deferred<{ tickets: Ticket[] }>();
  rpc.mockResolvedValueOnce({ tickets: [] }).mockReturnValueOnce(refresh.promise);
  await render();
  await vi.waitFor(() => expect(button("Refresh")).toBeDefined());
  const refreshButton = button("Refresh");

  state.foreground = false;
  await render();
  state.foreground = true;
  await render();
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  await act(flush);

  expect(host.textContent).toContain("No tickets yet.");
  expect(button("Refresh")).toBe(refreshButton);
  expect(refreshButton?.disabled).toBe(false);
  expect(host.querySelector('[role="progressbar"]')).toBeNull();

  await act(async () => refreshButton?.click());
  expect(refreshButton?.disabled).toBe(true);
  expect(rpc).toHaveBeenCalledTimes(2);

  await act(async () => refresh.resolve({ tickets: [ticket] }));
  await vi.waitFor(() => expect(host.textContent).toContain("Example ticket"));
});

it("keeps refresh available on a still-empty board and offers retry after a failed refresh", async () => {
  const refresh = deferred<{ tickets: Ticket[] }>();
  rpc
    .mockResolvedValueOnce({ tickets: [] })
    .mockReturnValueOnce(refresh.promise)
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ tickets: [] });
  await render();
  await vi.waitFor(() => expect(button("Refresh")).toBeDefined());

  await act(async () => button("Refresh")?.click());
  expect(button("Refresh")?.disabled).toBe(true);
  await act(async () => refresh.resolve({ tickets: [] }));
  await vi.waitFor(() => expect(button("Refresh")?.disabled).toBe(false));
  expect(host.textContent).toContain("No tickets yet.");
  expect(button("Retry")).toBeUndefined();

  await act(async () => button("Refresh")?.click());
  await vi.waitFor(() => expect(button("Retry")).toBeDefined());
  expect(host.textContent).toContain("Offline");
  expect(button("Refresh")).toBeUndefined();

  await act(async () => button("Retry")?.click());
  await vi.waitFor(() => expect(button("Refresh")).toBeDefined());
  expect(host.textContent).toContain("No tickets yet.");
  expect(button("Retry")).toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(4);
});

it("starts a new retry instead of joining a pending foreground refetch after an empty read fails", async () => {
  const backgroundRead = deferred<{ tickets: Ticket[] }>();
  rpc
    .mockResolvedValueOnce({ tickets: [] })
    .mockRejectedValueOnce(new Error("Offline"))
    .mockReturnValueOnce(backgroundRead.promise)
    .mockResolvedValueOnce({ tickets: [ticket] });
  await render();
  await vi.waitFor(() => expect(button("Refresh")).toBeDefined());
  await act(async () => button("Refresh")?.click());
  await vi.waitFor(() => expect(button("Retry")).toBeDefined());

  state.foreground = false;
  await render();
  state.foreground = true;
  await render();
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
  expect(button("Retry")).toBeDefined();

  await act(async () => button("Retry")?.click());
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => expect(host.textContent).toContain("Example ticket"));

  await act(async () => backgroundRead.resolve({ tickets: [] }));
  await act(flush);
  expect(host.textContent).toContain("Example ticket");
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
