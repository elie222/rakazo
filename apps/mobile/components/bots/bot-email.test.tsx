// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/query/query";
import { BotEmailAddressesGroup, useBotEmail, useBotEmailRows } from "./bot-email";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../lib/api/api", () => ({
  rpc,
  currentApiBase: () => "http://api.test",
  selectedSpaceId: () => "space-1",
  captureApiRequestContext: async () => ({
    apiBase: "http://api.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("../../lib/api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../../lib/platform/app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("../../lib/native/native", () => ({ native: {}, useMobileTokens: () => ({}) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => ({
  Text: ({ children }: { children?: ReactNode }) => <p role="alert">{children}</p>,
}));
vi.mock("../native/native-symbol", () => ({
  NativeSymbol: ({ ios }: { ios: string }) => <span data-icon={ios} />,
}));
vi.mock("../settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({
    title,
    accessibilityLabel,
    onPress,
    trailing,
  }: {
    title: string;
    accessibilityLabel?: string;
    onPress?: () => void;
    trailing?: ReactNode;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {title}
      {trailing}
    </button>
  ),
  SettingsInputRow: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (value: string) => void;
  }) => <input value={value} onChange={(event) => onChangeText(event.target.value)} />,
}));
// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

function Rows() {
  const email = useBotEmail("bot-1");
  return <div>{useBotEmailRows({ botId: "bot-1", botName: "Scout", email })}</div>;
}

let root: Root;
let container: HTMLDivElement;
let claimed: Deferred<{ address: string }>;
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  claimed = deferred();
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "bots/emailAddress") return { domain: "mail.test", address: null };
    if (procedure === "me") return { email: "owner@example.test" };
    if (procedure === "bots/claimEmailAddress") return claimed.promise;
    throw new Error(`unexpected ${procedure}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith(text));
const claims = () => rpc.mock.calls.filter(([procedure]) => procedure === "bots/claimEmailAddress");
async function type(value: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("claims once on a double tap and keeps the address over an older read", async () => {
  await act(async () => root.render(<Rows />));
  await act(async () => {
    button("Claim")!.click();
    button("Claim")!.click();
  });
  expect(claims()).toEqual([
    ["bots/claimEmailAddress", { botId: "bot-1", name: "scout" }, expect.anything()],
  ]);
  await act(async () => claimed.resolve({ address: "scout@mail.test" }));
  expect(button("scout@mail.test")).toBeDefined();
  // A read that started before the claim answers without the address.
  await act(async () => queryClient.invalidateQueries());
  expect(button("scout@mail.test")).toBeDefined();
});

it("shows the claimed address, not the claim form, on returning to the screen", async () => {
  await act(async () => root.render(<Rows />));
  await act(async () => button("Claim")!.click());
  await act(async () => claimed.resolve({ address: "scout@mail.test" }));
  await act(async () => root.unmount());
  // The screen's own read is held open, so only what the claim saved can show.
  rpc.mockImplementation(() => new Promise(() => undefined));
  root = createRoot(container);
  await act(async () => root.render(<Rows />));
  expect(button("scout@mail.test")).toBeDefined();
  expect(button("Claim")).toBeUndefined();
});

it("says why a name is refused, before sending it or after", async () => {
  await act(async () => root.render(<Rows />));
  await type("a");
  await act(async () => button("Claim")!.click());
  expect(container.textContent).toContain("Use 2 to 64 characters");
  expect(claims()).toHaveLength(0);
  await type("scout");
  expect(container.textContent).not.toContain("Use 2 to 64 characters");
  await act(async () => button("Claim")!.click());
  await act(async () => claimed.reject(new Error("Taken by another bot")));
  expect(container.textContent).toContain("Taken by another bot");
  await type("scout2");
  expect(container.querySelector("[role=alert]")).toBeNull();
});

const showsCopied = (text: string) => Boolean(button(text)?.querySelector("[data-icon=checkmark]"));
const labelOf = (text: string) => button(text)?.getAttribute("aria-label");
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

it("names the settings row Copied while its checkmark shows, then restores the copy name", async () => {
  vi.useFakeTimers();
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "bots/emailAddress")
      return { domain: "mail.test", address: "scout@mail.test" };
    if (procedure === "me") return { email: "owner@example.test" };
    throw new Error(`unexpected ${procedure}`);
  });
  await act(async () => root.render(<Rows />));
  expect(labelOf("scout@mail.test")).toBe("Copy scout@mail.test");
  await act(async () => button("scout@mail.test")!.click());
  expect(showsCopied("scout@mail.test")).toBe(true);
  expect(labelOf("scout@mail.test")).toBe("Copied");
  await advance(1499);
  expect(labelOf("scout@mail.test")).toBe("Copied");
  await advance(1);
  expect(showsCopied("scout@mail.test")).toBe(false);
  expect(labelOf("scout@mail.test")).toBe("Copy scout@mail.test");
});

it("keeps the settings checkmark for a full interval after copying the same address again", async () => {
  vi.useFakeTimers();
  rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "bots/emailAddress")
      return { domain: "mail.test", address: "scout@mail.test" };
    if (procedure === "me") return { email: "owner@example.test" };
    throw new Error(`unexpected ${procedure}`);
  });
  await act(async () => root.render(<Rows />));
  const copy = () => button("scout@mail.test")!.click();
  await act(async () => copy());
  expect(showsCopied("scout@mail.test")).toBe(true);
  await advance(1400);
  await act(async () => copy());
  await advance(1499);
  expect(showsCopied("scout@mail.test")).toBe(true);
  await advance(1);
  expect(showsCopied("scout@mail.test")).toBe(false);
});

it("moves the list checkmark and waits a full interval after copying a second address", async () => {
  vi.useFakeTimers();
  rpc.mockResolvedValueOnce({
    addresses: [
      { botId: "bot-1", botName: "Scout", address: "scout@mail.test" },
      { botId: "bot-2", botName: "Chief", address: "chief@mail.test" },
    ],
  });
  await act(async () => root.render(<BotEmailAddressesGroup />));
  await act(async () => button("Scout")!.click());
  expect(showsCopied("Scout")).toBe(true);
  await advance(1400);
  await act(async () => button("Chief")!.click());
  expect(showsCopied("Scout")).toBe(false);
  expect(showsCopied("Chief")).toBe(true);
  await advance(1499);
  expect(showsCopied("Chief")).toBe(true);
  await advance(1);
  expect(showsCopied("Chief")).toBe(false);
});

it("names only the copied list row Copied while its checkmark shows", async () => {
  vi.useFakeTimers();
  rpc.mockResolvedValueOnce({
    addresses: [
      { botId: "bot-1", botName: "Scout", address: "scout@mail.test" },
      { botId: "bot-2", botName: "Chief", address: "chief@mail.test" },
    ],
  });
  await act(async () => root.render(<BotEmailAddressesGroup />));
  expect(labelOf("Scout")).toBe("Copy scout@mail.test");
  expect(labelOf("Chief")).toBe("Copy chief@mail.test");
  await act(async () => button("Scout")!.click());
  expect(labelOf("Scout")).toBe("Copied");
  expect(labelOf("Chief")).toBe("Copy chief@mail.test");
  await advance(1400);
  await act(async () => button("Chief")!.click());
  expect(labelOf("Scout")).toBe("Copy scout@mail.test");
  expect(labelOf("Chief")).toBe("Copied");
  await advance(1500);
  expect(labelOf("Chief")).toBe("Copy chief@mail.test");
});

it("hides the bots' addresses when they cannot be read", async () => {
  rpc.mockResolvedValueOnce({
    addresses: [{ botId: "bot-1", botName: "Scout", address: "scout@mail.test" }],
  });
  await act(async () => root.render(<BotEmailAddressesGroup />));
  expect(button("Scout")).toBeDefined();
  rpc.mockRejectedValueOnce(new Error("offline"));
  await act(async () => queryClient.invalidateQueries());
  expect(container.textContent).toBe("");
});
