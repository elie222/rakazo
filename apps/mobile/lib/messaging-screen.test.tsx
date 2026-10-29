// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Linking } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MessagingSettings from "../app/(settings)/messaging";
import { rpc } from "./api";

const appState = vi.hoisted(() => ({ change: undefined as ((state: string) => void) | undefined }));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./user-error", () => ({
  errorText: (_: unknown, fallback = "Something went wrong. Try again.") => fallback,
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
    AppState: {
      addEventListener: (_: string, listener: (state: string) => void) => {
        appState.change = listener;
        return { remove: () => undefined };
      },
    },
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
  vi.mocked(rpc).mockImplementation(
    async (path: string) => (responses[path] ?? { ok: true }) as never,
  );
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

it("connects Slack to the default bot with workspace authorization", async () => {
  responses["messaging/status"] = { enabled: true, providers: ["slack"], identities: [] };
  responses["messaging/installations/list"] = { available: true, installations: [] };
  responses["messaging/installations/start"] = { url: "https://slack.example.test/authorize" };
  await act(async () => root.render(<MessagingSettings />));
  const buttons = [...container.querySelectorAll("button")];
  expect(container.textContent).toContain("Chat with your bot from Slack.");
  expect(buttons.filter((button) => button.textContent === "Connect")).toHaveLength(1);
  expect(
    buttons.some((button) =>
      ["Slack", "Connect a chat app", "Link DMs"].includes(button.textContent ?? ""),
    ),
  ).toBe(false);
  await act(async () => buttons.find((button) => button.textContent === "Connect")!.click());
  expect(rpc).toHaveBeenCalledWith("messaging/installations/start", {});
  expect(rpc).not.toHaveBeenCalledWith("messaging/link/start", expect.anything());
  expect(Linking.openURL).toHaveBeenCalledWith("https://slack.example.test/authorize");
});

it("links DMs to the bot that answers in the workspace", async () => {
  responses["messaging/status"] = {
    enabled: true,
    providers: ["slack", "telegram"],
    identities: [
      { id: "mi-other", provider: "telegram", botId: "bot-2", botName: "Team", address: "12345" },
    ],
  };
  responses["messaging/installations/list"] = {
    available: true,
    installations: [
      { id: "install-1", provider: "slack", workspaceName: "Example workspace", botId: "bot-2" },
    ],
  };
  await act(async () => root.render(<MessagingSettings />));
  await press("Slack", "Link DMs");
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-2" });
  expect(container.textContent).toContain("ABCD-2345");
});

it("lets a workspace member link DMs without installing the app again", async () => {
  responses["messaging/status"] = { enabled: true, providers: ["slack"], identities: [] };
  responses["messaging/installations/list"] = {
    available: true,
    installations: [],
    personalLinkAvailable: true,
  };
  await act(async () => root.render(<MessagingSettings />));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Link DMs")!
      .click(),
  );
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-1" });
  expect(rpc).not.toHaveBeenCalledWith("messaging/installations/start", expect.anything());
});

it("keeps a new DM code visible when Slack is already linked in another workspace", async () => {
  responses["messaging/status"] = {
    enabled: true,
    providers: ["slack"],
    identities: [
      {
        id: "mi-existing",
        provider: "slack",
        botId: "bot-1",
        botName: "Chief",
        address: "T-OTHER:U1",
      },
    ],
  };
  responses["messaging/installations/list"] = {
    available: true,
    installations: [],
    personalLinkAvailable: true,
  };
  await act(async () => root.render(<MessagingSettings />));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Link DMs")!
      .click(),
  );
  expect(container.textContent).toContain("ABCD-2345");
});

it("lets a member choose which bot their DMs link to in a teammate's workspace", async () => {
  responses["bots/list"] = [
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Lead" },
  ];
  responses["messaging/status"] = { enabled: true, providers: ["slack"], identities: [] };
  responses["messaging/installations/list"] = {
    available: true,
    installations: [],
    personalLinkAvailable: true,
  };
  await act(async () => root.render(<MessagingSettings />));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Lead")!
      .click(),
  );
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Link DMs")!
      .click(),
  );
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-2" });
});

it("offers a retry when the first load fails, then lists what it found", async () => {
  vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<MessagingSettings />));
  expect(container.textContent).not.toContain("Family");
  expect(container.textContent).toContain("Something went wrong. Try again.");

  await act(async () => {
    [...container.querySelectorAll("button")].find((node) => node.textContent === "Retry")!.click();
  });
  expect(container.textContent).toContain("Family");
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});

it("clears an old load error once a later load succeeds", async () => {
  vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<MessagingSettings />));
  expect(container.textContent).toContain("Something went wrong. Try again.");

  await act(async () => appState.change?.("active"));
  expect(container.textContent).toContain("Family");
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});

it("keeps a failed action's error when a refresh that was pending then succeeds", async () => {
  await act(async () => root.render(<MessagingSettings />));
  const answer = async (path: string) => (responses[path] ?? { ok: true }) as never;
  let finishRefresh!: () => void;
  vi.mocked(rpc).mockImplementation(async (path: string) => {
    if (path === "messaging/channels/respond") throw new Error("offline");
    if (path === "bots/list") {
      await new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
    }
    return answer(path);
  });
  await act(async () => appState.change?.("active"));

  await press("Family", "Approve");
  expect(container.textContent).toContain("Something went wrong. Try again.");

  await act(async () => finishRefresh());
  expect(container.textContent).toContain("Something went wrong. Try again.");
});
