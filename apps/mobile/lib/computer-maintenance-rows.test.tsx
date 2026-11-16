// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import { notifyManager } from "@tanstack/react-query";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComputerMaintenanceRows } from "../components/computer-maintenance-actions";
import { queryClient } from "./query";

const { rpc, alert, start, subscribe } = vi.hoisted(() => ({
  subscribe: vi.fn((_listener: () => void) => () => undefined),
  rpc: vi.fn(),
  alert: vi.fn(),
  start: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./computer-updates", () => ({
  computerUpdates: { start, subscribe },
}));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({ Alert: { alert } }));
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
    const reads: Array<(value: ComputerStatus) => void> = [];
    rpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          reads.push(resolve);
        }),
    );
    await act(async () => root.render(createElement(Rows)));
    await act(async () => reads[0]!(status({ busyBotName: "Other" })));
    // A finished update re-reads status while the previous re-read is still out.
    const listener = subscribe.mock.lastCall![0] as () => void;
    await act(async () => listener());
    await act(async () => listener());
    await act(async () => reads[2]!(status({ busyBotName: null })));
    await act(async () => reads[1]!(status({ busyBotName: "Other" })));
    expect(button("Recover computer")!.disabled).toBe(false);
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
