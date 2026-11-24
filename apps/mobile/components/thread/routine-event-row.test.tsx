// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetI18nForTests } from "../../lib/i18n/i18n";
import { WebhookKeyButton } from "./routine-event-row";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  copy: vi.fn(async () => true),
  confirmIdentity: vi.fn(async () => true),
  focused: true,
}));
vi.mock("expo-router", () => ({ useIsFocused: () => state.focused }));

vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  Pressable: ({
    onPress,
    accessibilityLabel,
    children,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
    children: ReactNode;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-label": accessibilityLabel },
      children,
    ),
}));
vi.mock("../../lib/appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-clipboard", () => ({ setStringAsync: state.copy }));
vi.mock("../../lib/api/api", () => ({
  rpc: state.rpc,
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("../../lib/api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../../lib/api/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../native/native-symbol", () => ({ NativeSymbol: () => null }));
// The real retry rule from contracts, with the device prompt replaced by `confirmIdentity`.
vi.mock("../vault/confirm-identity", async () => {
  const { runWithIdentityConfirmation } = await import("@rakazo/contracts");
  return {
    useIdentityConfirmation: () => ({
      withIdentityConfirmation: <T,>(action: () => Promise<T>) =>
        runWithIdentityConfirmation(action, state.confirmIdentity),
      identityDialog: null,
    }),
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetI18nForTests();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.rpc.mockReset();
  state.alert.mockReset();
  state.copy.mockClear();
  state.confirmIdentity.mockReset().mockResolvedValue(true);
  state.focused = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<WebhookKeyButton botId="bot-1" title="Deploy check" color="gray" />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const press = () =>
  act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Show webhook key"]')!.click(),
  );
const identityRequired = () =>
  Object.assign(new Error("Confirm it's you"), { code: "IDENTITY_CONFIRMATION_REQUIRED" });

it("reads the bot's key back and shows it with its URL, each ready to copy", async () => {
  state.rpc.mockResolvedValue({ secret: "key-123" });
  await press();
  await vi.waitFor(() => expect(state.alert).toHaveBeenCalled());
  expect(state.rpc).toHaveBeenCalledWith(
    "bots/revealWebhookSecret",
    { botId: "bot-1" },
    expect.anything(),
  );
  const [title, body, buttons] = state.alert.mock.calls[0]!;
  expect(title).toBe("Deploy check");
  expect(body).toBe(
    "https://app.example.test/api/v1/bots/bot-1/webhook\n\nAuthorization: Bearer key-123",
  );
  buttons[1].onPress();
  expect(state.copy).toHaveBeenCalledWith("key-123");
});

it("asks the person to confirm it's them, and shows nothing when they decline", async () => {
  state.rpc.mockRejectedValue(identityRequired());
  state.confirmIdentity.mockResolvedValue(false);
  await press();
  await vi.waitFor(() => expect(state.confirmIdentity).toHaveBeenCalledOnce());
  expect(state.alert).not.toHaveBeenCalled();
});

it("tells another member only the creator can see the key", async () => {
  state.rpc.mockRejectedValue(Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }));
  await press();
  await vi.waitFor(() => expect(state.alert).toHaveBeenCalled());
  expect(state.alert).toHaveBeenCalledWith("Only the bot's creator can see its webhook key.");
});

it("never shows a key that arrives after the person left the chat", async () => {
  const pending = deferred<{ secret: string }>();
  state.rpc.mockReturnValue(pending.promise);
  await press();
  await vi.waitFor(() => expect(state.rpc).toHaveBeenCalled());
  state.focused = false;
  act(() => root.render(<WebhookKeyButton botId="bot-1" title="Deploy check" color="gray" />));
  await act(async () => pending.resolve({ secret: "key-123" }));
  expect(state.alert).not.toHaveBeenCalled();
});
