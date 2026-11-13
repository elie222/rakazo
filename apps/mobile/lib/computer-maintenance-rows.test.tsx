// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComputerMaintenanceRows } from "../components/computer-maintenance-actions";

const { rpc, alert, start } = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  start: vi.fn(async () => undefined),
}));
vi.mock("./api", () => ({ rpc }));
vi.mock("./computer-updates", () => ({
  computerUpdates: { start, subscribe: () => () => undefined },
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

function Rows({ onError }: { onError: (message: string | null) => void }) {
  return createElement("div", null, ...useComputerMaintenanceRows("bot-fixture", onError));
}

describe("computer maintenance rows", () => {
  let root: Root;
  let container: HTMLDivElement;
  const status = (patch: Partial<ComputerStatus>) =>
    ({ state: "running", canUpdate: true, ...patch }) as ComputerStatus;
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === name);

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it("offers Update and a confirmed Reset", async () => {
    rpc.mockImplementation(async (procedure: string) =>
      procedure === "computer/status" ? status({}) : undefined,
    );
    await act(async () => root.render(createElement(Rows, { onError: vi.fn() })));
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "Update computer",
      "Reset computer",
    ]);

    await act(async () => button("Update computer")!.click());
    expect(start).toHaveBeenCalledWith("bot-fixture");

    await act(async () => button("Reset computer")!.click());
    expect(rpc).not.toHaveBeenCalledWith("computer/reset", expect.anything());
    const reset = alert.mock.lastCall![2].find(
      (action: { text: string }) => action.text === "Reset",
    );
    await act(async () => reset.onPress());
    expect(rpc).toHaveBeenCalledWith("computer/reset", { botId: "bot-fixture" });
  });

  it("hides Update for a computer that cannot update and disables rows while busy", async () => {
    rpc.mockResolvedValue(status({ canUpdate: false, busyBotName: "Other" }));
    await act(async () => root.render(createElement(Rows, { onError: vi.fn() })));
    expect(button("Update computer")).toBeUndefined();
    expect(button("Reset computer")!.disabled).toBe(true);
  });

  it("shows nothing without a computer", async () => {
    rpc.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(createElement(Rows, { onError: vi.fn() })));
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
