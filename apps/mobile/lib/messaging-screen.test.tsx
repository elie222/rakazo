// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MessagingSettings from "../app/(settings)/messaging";
import { rpc } from "./api";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (message: string, values: Record<string, string> = {}) =>
      message.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? ""),
  }),
}));
const push = vi.fn();
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
  useRouter: () => ({ push }),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ label, children }: { label?: string; children?: ReactNode }) => (
    <section aria-label={label}>{children}</section>
  ),
  SettingsRow: ({
    title,
    detail,
    value,
    trailing,
    onPress,
  }: {
    title: string;
    detail?: string;
    value?: string;
    trailing?: ReactNode;
    onPress?: () => void;
  }) => (
    <div data-row={title}>
      {onPress ? (
        <button type="button" onClick={onPress}>
          {title}
        </button>
      ) : (
        title
      )}{" "}
      {detail} {value}
      {trailing}
    </div>
  ),
}));
vi.mock("../components/menu-picker", () => {
  const Choices = ({
    choices,
    onChange,
  }: {
    choices: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) => (
    <>
      {choices.map((choice) => (
        <button key={choice.key} type="button" onClick={() => onChange(choice.key)}>
          {choice.label}
        </button>
      ))}
    </>
  );
  return { MenuPicker: Choices, MenuPickerMenu: Choices };
});
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View,
    ScrollView: View,
    Text: View,
    StyleSheet: { create: (styles: unknown) => styles },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Linking: { openURL: vi.fn() },
  };
});

const responses: Record<string, unknown> = {};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(responses, {
    "bots/list": [{ id: "bot-1", name: "Chief" }],
    "spaces/list": {
      current: {
        externalConversations: [{ id: "room-1", provider: "slack", displayName: "#launch" }],
      },
    },
    "messaging/status": {
      enabled: true,
      providers: ["sendblue"],
      addresses: { sendblue: "+15550001111" },
      openSignup: false,
      identities: [],
    },
    "messaging/installations/list": { available: false, installations: [] },
    "messaging/channels/list": [
      {
        id: "cm-invited",
        channelId: "ch-1",
        identityId: "mi-1",
        provider: "sendblue",
        name: "Family",
        status: "invited",
        memberCount: 3,
      },
      {
        id: "cm-joined",
        channelId: "ch-2",
        identityId: "mi-1",
        provider: "sendblue",
        name: "Ops",
        status: "approved",
        memberCount: 5,
      },
    ],
    "messaging/connections/list": [
      {
        id: "ac-in",
        peerBotName: "Assistant",
        peerOwnerLabel: "Dana",
        status: "pending",
        incoming: true,
      },
      {
        id: "ac-ok",
        peerBotName: "Helper",
        peerOwnerLabel: "Sam",
        status: "approved",
        incoming: false,
      },
    ],
    "messaging/link/start": {
      code: "ABCD-2345",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    },
  });
  vi.mocked(rpc).mockImplementation(async (path: string) => responses[path] ?? { ok: true });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function button(row: string, label: string) {
  const found = [...container.querySelectorAll(`[data-row="${row}"] button`)].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label} on ${row}`);
  return found as HTMLButtonElement;
}

async function press(row: string, label: string) {
  await act(async () => button(row, label).click());
}

function listCalls() {
  return vi.mocked(rpc).mock.calls.filter(([path]) => path === "messaging/channels/list").length;
}

it("answers requests and manages conversations by their own ids, then refreshes", async () => {
  await act(async () => root.render(<MessagingSettings />));
  const before = listCalls();

  await press("Family", "Approve");
  expect(rpc).toHaveBeenCalledWith("messaging/channels/respond", {
    membershipId: "cm-invited",
    accept: true,
  });
  await press("Family", "Decline");
  expect(rpc).toHaveBeenCalledWith("messaging/channels/respond", {
    membershipId: "cm-invited",
    accept: false,
  });
  await press("Dana's Assistant", "Approve");
  expect(rpc).toHaveBeenCalledWith("messaging/connections/respond", {
    connectionId: "ac-in",
    accept: true,
  });
  await press("Dana's Assistant", "Decline");
  expect(rpc).toHaveBeenCalledWith("messaging/connections/respond", {
    connectionId: "ac-in",
    accept: false,
  });
  await press("Ops", "Leave");
  expect(rpc).toHaveBeenCalledWith("messaging/channels/leave", { membershipId: "cm-joined" });
  await press("Sam's Helper", "Revoke");
  expect(rpc).toHaveBeenCalledWith("messaging/connections/revoke", { connectionId: "ac-ok" });

  expect(listCalls()).toBe(before + 6);
});

it("says which line to send a link code to", async () => {
  await act(async () => root.render(<MessagingSettings />));
  const imessage = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "iMessage",
  );
  await act(async () => imessage?.click());
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-1" });
  expect(container.textContent).toContain(
    "Send ABCD-2345 to +15550001111 from iMessage within 10 minutes.",
  );
});

it("falls back to the first bot when the selected one is archived elsewhere", async () => {
  responses["bots/list"] = [
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Lead" },
  ];
  await act(async () => root.render(<MessagingSettings />));
  const lead = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Lead",
  );
  await act(async () => lead?.click());

  // Lead is archived on another device; the next refresh drops it.
  responses["bots/list"] = [{ id: "bot-1", name: "Chief" }];
  await press("Family", "Approve");
  const imessage = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "iMessage",
  );
  await act(async () => imessage?.click());
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-1" });
  expect(rpc).not.toHaveBeenCalledWith("messaging/link/start", { botId: "bot-2" });
});

it("opens a team conversation's room settings", async () => {
  await act(async () => root.render(<MessagingSettings />));
  await press("#launch", "#launch");
  expect(push).toHaveBeenCalledWith({
    pathname: "/team-conversation",
    params: { conversationId: "room-1" },
  });
});
