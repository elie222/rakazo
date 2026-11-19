// @vitest-environment jsdom

import { COMPUTER_RUNNING_ERROR } from "@rakazo/contracts";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/query/query";
import { useComputerHomeVersionRows } from "./computer-home-versions";

const { rpc, alert, appState } = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  appState: { currentState: "active", listeners: new Set<() => void>() },
}));
vi.mock("../../lib/api/api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async (spaceId?: string) => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": spaceId ?? "space-1" },
  }),
}));
vi.mock("../../lib/api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  Alert: { alert },
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_: string, listener: () => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
  View: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../../lib/native/native", () => ({ native: {} }));
vi.mock("../settings/settings-group", () => ({
  SettingsRow: ({ title }: { title: string }) => createElement("p", null, title),
}));
vi.mock("../ui/menu-picker", () => ({
  MenuPickerMenu: ({
    choices,
    onChange,
    children,
  }: {
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      null,
      children,
      ...choices.map((choice) =>
        createElement(
          "button",
          { key: choice.key, type: "button", onClick: () => onChange(choice.key) },
          choice.key,
        ),
      ),
    ),
}));

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

function Rows() {
  return createElement("div", null, ...useComputerHomeVersionRows("bot-fixture"));
}

const versions = [
  { id: "rev-2", savedAt: "2026-11-19T10:00:00.000Z" },
  { id: "rev-1", savedAt: "2026-11-18T10:00:00.000Z" },
];

describe("computer home version rows", () => {
  let root: Root;
  let container: HTMLDivElement;
  const choose = async (versionId: string) => {
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === versionId)!
        .click(),
    );
    const restore = alert.mock.lastCall![2].find(
      (action: { text: string }) => action.text === "Restore",
    );
    await act(async () => restore.onPress());
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    appState.currentState = "active";
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it("offers nothing until the computer has an earlier version", async () => {
    rpc.mockResolvedValue([]);
    await act(async () => root.render(createElement(Rows)));
    expect(container.textContent).toBe("");
  });

  it("says when the versions could not be read", async () => {
    rpc.mockRejectedValue(new Error("storage down"));
    await act(async () => root.render(createElement(Rows)));
    await vi.waitFor(() => expect(container.textContent).toBe("Could not load earlier versions"));
  });

  it("reads the versions again when the app comes back", async () => {
    rpc.mockResolvedValue([]);
    await act(async () => root.render(createElement(Rows)));
    const reads = () =>
      rpc.mock.calls.filter(([procedure]) => procedure === "computer/homeVersions").length;
    const before = reads();
    rpc.mockResolvedValue(versions);
    const setState = async (state: string) => {
      appState.currentState = state;
      await act(async () => {
        for (const listener of appState.listeners) listener();
      });
    };
    await setState("background");
    await setState("active");

    expect(reads()).toBe(before + 1);
    expect(container.textContent).toContain("Restore earlier version");
  });

  it("restores the chosen version once confirmed", async () => {
    rpc.mockImplementation(async (procedure: string) =>
      procedure === "computer/homeVersions" ? versions : { ok: true },
    );
    await act(async () => root.render(createElement(Rows)));
    expect(container.textContent).toContain("Restore earlier version");

    await choose("rev-1");

    expect(rpc).toHaveBeenCalledWith(
      "computer/restoreHomeVersion",
      { botId: "bot-fixture", versionId: "rev-1" },
      expect.anything(),
    );
  });

  it("asks to stop a running computer first", async () => {
    rpc.mockImplementation(async (procedure: string) => {
      if (procedure === "computer/homeVersions") return versions;
      throw Object.assign(new Error("Stop the computer"), { code: COMPUTER_RUNNING_ERROR });
    });
    await act(async () => root.render(createElement(Rows)));

    await choose("rev-2");

    expect(container.textContent).toContain("Stop the computer first.");
  });
});
