// @vitest-environment jsdom
import type { Deferred } from "@rakazo/core/test-async";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AiDataSharing from "../app/(settings)/ai-data-sharing";
import { queryClient, resetRpcQueries } from "./query";

type AlertButton = { text: string; onPress?: () => void };
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  prompt: vi.fn(),
  focused: true,
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./api", () => ({
  rpc: mocks.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async (spaceId: string | null = "space-1") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
  useIsFocused: () => mocks.focused,
}));
vi.mock("./ai-consent", () => ({
  aiDataDisclosure: (use: string) => `About ${use}`,
  promptAiConsent: mocks.prompt,
}));
vi.mock("../components/settings-group", () => ({
  useStackedSettings: () => false,
  SettingsFooter: ({ children }: { children?: ReactNode }) => <small>{children}</small>,
  SettingsGroup: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({
    title,
    onPress,
    disabled,
  }: {
    title: string;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
  SettingsSwitch: ({
    accessibilityLabel: label,
    value,
    disabled,
    onChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={label}
      checked={value}
      disabled={disabled}
      onChange={() => onChange(!value)}
    />
  ),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => <span role="status" />,
  Alert: { alert: mocks.alert },
  Linking: { openURL: vi.fn() },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: unknown) => styles },
}));

const recipient = (key: string, allowed: boolean) => ({
  key,
  name: key,
  use: "model",
  detail: "",
  allowed,
});
const status = (allowed: Record<string, boolean>) => ({
  scope: "mobile",
  version: "v1",
  recipients: Object.entries(allowed).map(([key, value]) => recipient(key, value)),
});
const opened = status({ Models: true, Speech: false });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  mocks.focused = true;
  mocks.prompt.mockResolvedValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function settle() {
  await act(flush);
}
async function render() {
  await act(async () => root.render(<AiDataSharing />));
  await settle();
}
const toggle = (name: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
const withdraw = () =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Withdraw all permissions",
  )!;
const controls = () => [...container.querySelectorAll<HTMLInputElement>("input"), withdraw()];
function lastAlert() {
  const [title, message, buttons] = mocks.alert.mock.lastCall as [string, string, AlertButton[]?];
  return {
    title,
    message,
    press: (text: string) => buttons?.find((b) => b.text === text)?.onPress?.(),
  };
}
/** Answers the opening read, and holds the named write open so a test decides how it ends. */
function hold(write: string, answer = opened) {
  let finish!: (outcome: Error | typeof opened) => void;
  mocks.rpc.mockImplementation((proc: string) =>
    proc === "aiConsent/status"
      ? Promise.resolve(answer)
      : proc === write
        ? new Promise((resolve, reject) => {
            finish = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
          })
        : Promise.reject(new Error(`Unexpected ${proc}`)),
  );
  return {
    finish: async (outcome: Error | typeof opened) => {
      await act(async () => finish(outcome));
      await settle();
    },
    calls: () => mocks.rpc.mock.calls.filter(([proc]) => proc === write),
  };
}

/** What every write carries: the server, session and space its save was started in. */
const pinned = {
  requestContext: {
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  },
};
it("shows each service's permission, and allows one only after its consent prompt", async () => {
  const allow = hold("aiConsent/allow");
  await render();
  expect(toggle("Allow Models on mobile").checked).toBe(true);
  expect(toggle("Allow Speech on mobile").checked).toBe(false);

  await act(async () => toggle("Allow Speech on mobile").click());
  expect(mocks.prompt).toHaveBeenCalledWith(opened.recipients[1], undefined);
  expect(allow.calls()).toEqual([
    ["aiConsent/allow", { scope: "mobile", version: "v1", keys: ["Speech"] }, pinned],
  ]);
  expect(controls().map((control) => control.disabled)).toEqual([true, true, true]);

  await allow.finish(status({ Models: true, Speech: true }));
  expect(toggle("Allow Speech on mobile").checked).toBe(true);
  expect(controls().map((control) => control.disabled)).toEqual([false, false, false]);
  expect(mocks.alert).not.toHaveBeenCalled();
});

it("holds the controls during the consent prompt, and saves nothing when it is declined", async () => {
  const answer = deferred<boolean>();
  mocks.prompt.mockReturnValue(answer.promise);
  const allow = hold("aiConsent/allow");
  await render();
  await act(async () => toggle("Allow Speech on mobile").click());
  expect(controls().map((control) => control.disabled)).toEqual([true, true, true]);

  await act(async () => answer.resolve(false));
  await settle();
  expect(allow.calls()).toEqual([]);
  expect(toggle("Allow Speech on mobile").checked).toBe(false);
  expect(controls().map((control) => control.disabled)).toEqual([false, false, false]);
});

it("revokes one service without asking, and says so in an alert when that fails", async () => {
  const revoke = hold("aiConsent/revoke");
  await render();
  await act(async () => toggle("Allow Models on mobile").click());
  expect(mocks.prompt).not.toHaveBeenCalled();
  expect(revoke.calls()).toEqual([["aiConsent/revoke", { key: "Models" }, pinned]]);

  await revoke.finish(new Error("Server said no"));
  expect(lastAlert()).toMatchObject({ title: "AI data sharing", message: "Server said no" });
  expect(toggle("Allow Models on mobile").checked).toBe(true);
  expect(controls().map((control) => control.disabled)).toEqual([false, false, false]);

  await act(async () => toggle("Allow Models on mobile").click());
  await revoke.finish(status({ Models: false, Speech: false }));
  expect(toggle("Allow Models on mobile").checked).toBe(false);
});

it("withdraws every permission only after a destructive confirm", async () => {
  const revoke = hold("aiConsent/revoke");
  await render();
  await act(async () => withdraw().click());
  expect(lastAlert().title).toBe("Withdraw all permissions?");
  expect(revoke.calls()).toEqual([]);

  await act(async () => lastAlert().press("Withdraw"));
  expect(revoke.calls()).toEqual([["aiConsent/revoke", { key: null }, pinned]]);
  expect(controls().map((control) => control.disabled)).toEqual([true, true, true]);
  await revoke.finish(status({ Models: false, Speech: false }));
  expect(toggle("Allow Models on mobile").checked).toBe(false);
  expect(controls().map((control) => control.disabled)).toEqual([false, false, false]);
});

it("offers a retry in an alert when the permissions fail to load", async () => {
  const answer = deferred<typeof opened>();
  mocks.rpc.mockRejectedValueOnce(new Error("Server said no")).mockReturnValue(answer.promise);
  await render();
  expect(container.textContent).toContain("Could not load permissions.");
  expect(container.querySelector("input")).toBeNull();
  expect(lastAlert()).toMatchObject({ title: "AI data sharing", message: "Server said no" });

  await act(async () => lastAlert().press("Retry"));
  await settle();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Could not load permissions.");
  await act(async () => answer.resolve(opened));
  await settle();
  expect(toggle("Allow Models on mobile").checked).toBe(true);
  expect(mocks.alert).toHaveBeenCalledTimes(1);
});

it("holds a failed read's alert while another screen covers this one, until the return", async () => {
  mocks.rpc.mockResolvedValue(opened);
  await render();
  mocks.focused = false;
  await render();
  mocks.rpc.mockRejectedValue(new Error("Server said no"));
  await act(async () => resetRpcQueries("aiConsent/status"));
  await settle();
  expect(mocks.alert).not.toHaveBeenCalled();

  mocks.focused = true;
  await render();
  expect(lastAlert()).toMatchObject({ title: "AI data sharing", message: "Server said no" });
  expect(mocks.alert).toHaveBeenCalledTimes(1);
});

it("reads the permissions again on a later visit, so one allowed elsewhere shows as allowed", async () => {
  mocks.rpc.mockResolvedValue(opened);
  await render();
  expect(toggle("Allow Speech on mobile").checked).toBe(false);

  await act(async () => root.render(null));
  mocks.rpc.mockResolvedValue(status({ Models: true, Speech: true }));
  await render();
  expect(toggle("Allow Speech on mobile").checked).toBe(true);
});

it("reads the permissions again while open, once a consent prompt elsewhere has allowed one", async () => {
  mocks.rpc.mockResolvedValue(opened);
  await render();
  mocks.rpc.mockResolvedValue(status({ Models: true, Speech: true }));
  await act(async () => resetRpcQueries("aiConsent/status"));
  await settle();
  expect(toggle("Allow Speech on mobile").checked).toBe(true);
});

it("keeps a change when a read that started before it lands afterwards", async () => {
  const revoke = hold("aiConsent/revoke");
  await render();
  const answer = mocks.rpc.getMockImplementation()!;
  let land!: Deferred<typeof opened>;
  mocks.rpc.mockImplementation((proc: string) => {
    if (proc !== "aiConsent/status") return answer(proc);
    land = deferred<typeof opened>();
    return land.promise;
  });
  await act(async () => void queryClient.refetchQueries());
  await act(async () => toggle("Allow Models on mobile").click());
  await revoke.finish(status({ Models: false, Speech: false }));
  await act(async () => land.resolve(opened));
  await settle();
  expect(toggle("Allow Models on mobile").checked).toBe(false);
});

it("says when no AI service is configured", async () => {
  mocks.rpc.mockResolvedValue(status({}));
  await render();
  expect(container.textContent).toContain("No AI services configured.");
});

it("saves once when a switch reports two changes in one tick", async () => {
  const revoke = hold("aiConsent/revoke");
  await render();
  await act(async () => {
    toggle("Allow Models on mobile").click();
    toggle("Allow Models on mobile").click();
  });
  expect(revoke.calls()).toHaveLength(1);
});

it("keeps a revoked permission when the next read fails, and offers only to read again", async () => {
  const revoke = hold("aiConsent/revoke");
  await render();
  await act(async () => toggle("Allow Models on mobile").click());
  await revoke.finish(status({ Models: false, Speech: false }));

  await act(async () => root.render(null));
  mocks.rpc.mockRejectedValue(new Error("Server said no"));
  await act(async () => queryClient.invalidateQueries());
  await render();
  expect(toggle("Allow Models on mobile").checked).toBe(false);
  expect(controls().map((control) => control.disabled)).toEqual([false, false, false]);
  expect(mocks.alert).toHaveBeenCalledTimes(1);
  const [, , buttons] = mocks.alert.mock.calls[0] as [string, string, AlertButton[]];
  expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Retry"]);
});

it.each([
  ["succeeds", status({ Models: false, Speech: false })],
  ["fails", new Error("Server said no")],
])("shows no alert when a change %s after the screen has gone", async (_how, outcome) => {
  const revoke = hold("aiConsent/revoke");
  await render();
  await act(async () => toggle("Allow Models on mobile").click());
  await act(async () => root.render(null));
  await revoke.finish(outcome);
  expect(mocks.alert).not.toHaveBeenCalled();
});
