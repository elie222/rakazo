// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TailnetBotAccess } from "../components/tailnet-bot-access";
import { rpc } from "./api/api";
import { queryClient } from "./query/query";

const alert = vi.hoisted(() => vi.fn());
vi.mock("./api/api", () => ({
  rpc: vi.fn(),
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async (spaceId: string | null = "space-1") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("./api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("./api/user-error", () => ({
  errorText: (_: unknown, fallback = "Something went wrong. Try again.") => fallback,
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
  };
});
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ children, label }: { children?: ReactNode; label?: string }) => (
    <section aria-label={label}>{children}</section>
  ),
  SettingsSwitch: ({
    label,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
    />
  ),
}));
vi.mock("react-native", () => ({ Alert: { alert } }));

const connected = (botIds: string[]) => ({
  unavailable: null,
  connection: { tag: "tag:rakazo", botIds },
});

let container: HTMLDivElement;
let root: Root;
let status: unknown;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  status = connected([]);
  vi.mocked(rpc).mockImplementation((async (path: string, input?: unknown) => {
    if (path === "tailnet/status") return status;
    if (path === "tailnet/setBotAccess") {
      const { botId, enabled } = input as { botId: string; enabled: boolean };
      return connected(enabled ? [botId] : []);
    }
    throw new Error(`Unexpected ${path}`);
  }) as never);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<TailnetBotAccess botId="helper" />));
  await act(flush);
}

const toggle = () =>
  container.querySelector<HTMLButtonElement>('[aria-label="Reach machines on your tailnet"]');

it("shows nothing until the member has connected a tailnet here", async () => {
  status = { unavailable: null, connection: null };
  await render();
  expect(container.textContent).toBe("");
  expect(toggle()).toBeNull();
});

it("shows nothing on a server that can't put bots on a tailnet", async () => {
  status = { unavailable: "unsupported", connection: connected(["helper"]).connection };
  await render();
  expect(toggle()).toBeNull();
});

it("lets the bot on and shows the saved answer", async () => {
  await render();
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle()?.click());
  expect(rpc).toHaveBeenCalledWith(
    "tailnet/setBotAccess",
    { botId: "helper", enabled: true },
    expect.anything(),
  );
  await act(flush);
  expect(toggle()?.getAttribute("aria-checked")).toBe("true");
});

it("explains a save that failed and keeps the saved state", async () => {
  await render();
  vi.mocked(rpc).mockRejectedValueOnce(new Error("refused"));
  await act(async () => toggle()?.click());
  await act(flush);
  expect(alert).toHaveBeenCalledWith("Tailnet", "Couldn't update tailnet access");
  expect(toggle()?.getAttribute("aria-checked")).toBe("false");
});
