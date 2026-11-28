// @vitest-environment jsdom

import type { RpcOutput } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/query/query";
import { PrimaryRuntimeSettings, usePrimaryRuntimeSettings } from "./primary-runtime-settings";

const state = vi.hoisted(() => ({ rpc: vi.fn(), foreground: true }));
vi.mock("../../lib/api/api", () => ({
  currentApiBase: () => "https://example.test",
  selectedSpaceId: () => "space-fixture",
  captureApiRequestContext: async () => ({
    apiBase: "https://example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-fixture" },
  }),
  rpc: state.rpc,
}));
vi.mock("../../lib/api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../../lib/platform/app-foreground", () => ({ useAppForeground: () => state.foreground }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...args: string[]) =>
      parts.reduce((label, part, index) => label + part + (args[index] ?? ""), ""),
  }),
}));
vi.mock("../settings/settings-group", () => ({
  SettingsGroup: ({ children, label }: { children: ReactNode; label: string }) => (
    <section aria-label={label}>{children}</section>
  ),
  SettingsRow: ({
    title,
    detail,
    onPress,
    disabled,
  }: {
    title: string;
    detail?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    onPress ? (
      <button type="button" disabled={disabled} onClick={onPress}>
        {title}
      </button>
    ) : (
      <p>
        {title}: {detail}
      </p>
    ),
}));
vi.mock("../ui/menu-picker", () => ({
  MenuPicker: ({
    choices,
    value,
    onChange,
    disabled,
  }: {
    choices: { key: string; label: string; disabled?: boolean }[];
    value: string;
    onChange: (key: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="Runtime preference"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key} disabled={choice.disabled}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
}));

type Settings = RpcOutput<"bots/primaryRuntime">;
function settingsFor(account: string, revision = 0): Settings {
  return {
    preference: null,
    revision,
    canSelectClaude: true,
    direct: "pi",
    group: "unavailable",
    model: {
      modelProvider: "anthropic",
      modelId: "claude-sonnet",
      modelCredentialId: `id:${account}`,
    },
    connectionLabel: account,
  };
}

let stored: Settings;
let container: HTMLElement;
let root: Root;

function Fixture({ staged = false, profilePending = false }) {
  const runtime = usePrimaryRuntimeSettings("bot-fixture", true);
  return (
    <>
      <PrimaryRuntimeSettings
        runtime={runtime}
        modelBindingEdited={staged}
        profilePending={profilePending}
      />
      <button
        type="button"
        onClick={() =>
          void queryClient.invalidateQueries({
            queryKey: runtime.readKey,
            exact: true,
          })
        }
      >
        Refresh after profile save
      </button>
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  stored = settingsFor("Account A");
  state.foreground = true;
  state.rpc.mockReset().mockImplementation(async (proc) => {
    if (proc === "bots/primaryRuntime") return stored;
    if (proc === "bots/setPrimaryRuntime") {
      stored = { ...stored, revision: stored.revision + 1, preference: "claude-agent" };
      return { status: "changed", committedRevision: stored.revision, settings: stored };
    }
    throw new Error(`Unexpected procedure: ${proc}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

async function render(staged = false, pending = false) {
  await act(async () => root.render(<Fixture staged={staged} profilePending={pending} />));
  await act(flush);
}
function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await act(flush);
}
async function choose(selection: string) {
  const picker = container.querySelector("select")!;
  await act(async () => {
    picker.value = selection;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const writes = () => state.rpc.mock.calls.filter(([proc]) => proc === "bots/setPrimaryRuntime");

it("holds a Claude draft while B is staged, then requires deliberate review of saved B", async () => {
  await render();
  expect(container.textContent).toContain("Account A");
  expect(container.textContent).toContain("Direct chat: Pi");
  expect(container.textContent).toContain("Group chat: Unavailable");
  expect(container.textContent).not.toContain("id:Account");
  await render(true);
  await choose("claude-agent");
  expect(container.textContent).toContain("Save your model or connection changes");
  expect(button("Save runtime").disabled).toBe(true);
  await click("Save runtime");
  expect(writes()).toHaveLength(0);
  await render(true, true);
  stored = settingsFor("Account B");
  await click("Refresh after profile save");
  await render();
  expect(container.textContent).toContain("Account B");
  expect(button("Save runtime").disabled).toBe(true);
  await click("Keep my selection");
  expect(button("Save runtime").disabled).toBe(false);
  await click("Save runtime");
  expect(writes()).toHaveLength(1);
  expect(writes()[0]?.[1]).toEqual({
    botId: "bot-fixture",
    preference: "claude-agent",
    expectedRevision: 0,
    expectedModel: settingsFor("Account B").model,
  });
});

it("preserves the draft and blocks a write after a newer revision is seen on foreground", async () => {
  await render();
  await choose("pi");
  state.foreground = false;
  await render();
  stored = settingsFor("Account A", 2);
  state.foreground = true;
  await render();
  expect(container.querySelector("select")?.value).toBe("pi");
  expect(button("Save runtime").disabled).toBe(true);
  await click("Keep my selection");
  await click("Save runtime");
  expect(writes()[0]?.[1]).toMatchObject({ expectedRevision: 2, preference: "pi" });
});

it("keeps a rejected draft for review and never automatically retries", async () => {
  await render();
  await choose("claude-agent");
  state.rpc.mockImplementation(async (proc) => {
    stored = settingsFor("Account B", 3);
    return proc === "bots/primaryRuntime"
      ? stored
      : { status: "conflict", committedRevision: null, settings: stored };
  });
  await click("Save runtime");
  expect(writes()).toHaveLength(1);
  expect(container.querySelector("select")?.value).toBe("claude-agent");
  expect(button("Save runtime").disabled).toBe(true);
  expect(button("Keep my selection").disabled).toBe(false);
});

it("hides owner-only settings on 404 and disables unenrolled Claude", async () => {
  stored = { ...stored, canSelectClaude: false };
  await render();
  expect(container.querySelector<HTMLOptionElement>('option[value="claude-agent"]')?.disabled).toBe(
    true,
  );
  state.rpc.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
  await click("Refresh after profile save");
  expect(container.querySelector("section")).toBeNull();
  expect(writes()).toHaveLength(0);
});
