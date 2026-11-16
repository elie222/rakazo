// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComputerMaintenanceRows } from "../components/computer-maintenance-actions";
import { queryClient } from "./query";

const { rpc, alert, start, subscribe, selection } = vi.hoisted(() => ({
  selection: { space: "space-1" },
  subscribe: vi.fn((_listener: () => void) => () => undefined),
  rpc: vi.fn(),
  alert: vi.fn(),
  start: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("./api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => selection.space,
  captureApiRequestContext: async (spaceId?: string) => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": spaceId ?? selection.space },
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./computer-updates", () => ({
  computerUpdates: { start, subscribe },
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  Alert: { alert },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("../components/settings-group", () => ({
  SettingsRow: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, title),
}));

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

function Rows() {
  return createElement("div", null, ...useComputerMaintenanceRows("bot-fixture"));
}

describe("computer maintenance rows", () => {
  let root: Root;
  let container: HTMLDivElement;
  const status = (patch: Partial<ComputerStatus>) =>
    ({ botId: "bot-fixture", state: "error", canUpdate: true, ...patch }) as ComputerStatus;
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === name);

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    selection.space = "space-1";
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it("offers a confirmed Recover where the computer can update in place", async () => {
    rpc.mockImplementation(async (procedure: string) =>
      procedure === "computer/status" ? status({}) : undefined,
    );
    await act(async () => root.render(createElement(Rows)));
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "Recover computer",
    ]);
    await act(async () => button("Recover computer")!.click());
    expect(start).not.toHaveBeenCalled();
    const recover = alert.mock.lastCall![2].find(
      (action: { text: string }) => action.text === "Recover computer",
    );
    await act(async () => recover.onPress());
    expect(start).toHaveBeenCalledWith("bot-fixture", "recover", expect.any(Function));
    // The start is sent through the save, pinned to the Space it was asked in.
    const begin = start.mock.lastCall![2] as (botId: string, action: string) => Promise<unknown>;
    await begin("bot-fixture", "recover");
    expect(rpc).toHaveBeenLastCalledWith(
      "computer/recover",
      { botId: "bot-fixture" },
      { requestContext: expect.objectContaining({ apiBase: "http://api.test" }) },
    );
  });

  it("offers a confirmed Reset otherwise and disables it while busy", async () => {
    rpc.mockImplementation(async (procedure: string) =>
      procedure === "computer/status" ? status({ canUpdate: false }) : undefined,
    );
    await act(async () => root.render(createElement(Rows)));
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "Reset computer",
    ]);
    await act(async () => button("Reset computer")!.click());
    expect(rpc).not.toHaveBeenCalledWith("computer/reset", expect.anything(), expect.anything());
    const reset = alert.mock.lastCall![2].find(
      (action: { text: string }) => action.text === "Reset",
    );
    await act(async () => reset.onPress());
    expect(rpc).toHaveBeenCalledWith("computer/reset", { botId: "bot-fixture" }, expect.anything());

    rpc.mockResolvedValue(status({ canUpdate: false, busyBotName: "Other" }));
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(Rows)));
    expect(button("Reset computer")!.disabled).toBe(true);
  });

  it("shows a failed action's error in the group", async () => {
    rpc.mockImplementation(async (procedure: string) => {
      if (procedure === "computer/status") return status({ canUpdate: false });
      throw new Error("Reset failed");
    });
    await act(async () => root.render(createElement(Rows)));
    await act(async () => button("Reset computer")!.click());
    const reset = alert.mock.lastCall![2].find(
      (action: { text: string }) => action.text === "Reset",
    );
    await act(async () => reset.onPress());
    expect(container.textContent).toContain("Reset failed");
  });

  it("ignores a status read that a newer one superseded", async () => {
    const opening = deferred<ComputerStatus>();
    const older = deferred<ComputerStatus>();
    const newer = deferred<ComputerStatus>();
    rpc
      .mockReturnValueOnce(opening.promise)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    await act(async () => root.render(createElement(Rows)));
    await act(async () => opening.resolve(status({ busyBotName: "Other" })));
    // A finished update re-reads status while the previous re-read is still out.
    const listener = subscribe.mock.lastCall![0] as () => void;
    await act(async () => listener());
    await act(async () => listener());
    await act(async () => newer.resolve(status({ busyBotName: null })));
    await act(async () => older.resolve(status({ busyBotName: "Other" })));
    expect(button("Recover computer")!.disabled).toBe(false);
  });

  it("keeps reading and repairing the bot's own Space after another is selected", async () => {
    rpc.mockImplementation(async (procedure: string) =>
      procedure === "computer/status" ? status({ canUpdate: false }) : undefined,
    );
    await act(async () => root.render(createElement(Rows)));
    selection.space = "space-2";
    await act(async () => root.render(createElement(Rows)));
    const listener = subscribe.mock.lastCall![0] as () => void;
    await act(async () => listener());
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(button("Reset computer")).toBeDefined();
    await act(async () => button("Reset computer")!.click());
    const reset = alert.mock.lastCall![2].find(
      (action: { text: string }) => action.text === "Reset",
    );
    await act(async () => reset.onPress());
    expect(rpc).toHaveBeenCalledWith(
      "computer/reset",
      { botId: "bot-fixture" },
      { requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-1" } }) },
    );
  });

  it("recovers another Space's computer without showing its progress in the selected one", async () => {
    rpc.mockImplementation(async (procedure: string) =>
      procedure === "computer/status" ? status({}) : undefined,
    );
    await act(async () => root.render(createElement(Rows)));
    selection.space = "space-2";
    await act(async () => button("Recover computer")!.click());
    const recover = alert.mock.lastCall![2].find(
      (action: { text: string }) => action.text === "Recover computer",
    );
    await act(async () => recover.onPress());
    expect(start).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "computer/recover",
      { botId: "bot-fixture" },
      { requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space-1" } }) },
    );
  });

  it("offers no repair from an earlier visit's status until it is read again", async () => {
    rpc.mockResolvedValue(status({ canUpdate: false }));
    await act(async () => root.render(createElement(Rows)));
    expect(button("Reset computer")).toBeDefined();
    await act(async () => root.unmount());
    // The computer recovered elsewhere; the return visit's read is still out.
    const reread = deferred<ComputerStatus>();
    rpc.mockReturnValue(reread.promise);
    root = createRoot(container);
    await act(async () => root.render(createElement(Rows)));
    expect(container.querySelectorAll("button")).toHaveLength(0);
    await act(async () => reread.resolve(status({ state: "running" })));
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("disables the repair while its status is read again", async () => {
    rpc.mockResolvedValue(status({ canUpdate: false }));
    await act(async () => root.render(createElement(Rows)));
    const reread = deferred<ComputerStatus>();
    rpc.mockReturnValue(reread.promise);
    const listener = subscribe.mock.lastCall![0] as () => void;
    await act(async () => listener());
    expect(button("Reset computer")!.disabled).toBe(true);
    await act(async () => reread.resolve(status({ canUpdate: false })));
    expect(button("Reset computer")!.disabled).toBe(false);
  });

  it("shows nothing while the computer is not broken", async () => {
    rpc.mockResolvedValue(status({ state: "running" }));
    await act(async () => root.render(createElement(Rows)));
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows nothing without a computer", async () => {
    rpc.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(createElement(Rows)));
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
