// @vitest-environment jsdom

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { Linking } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MessagingSettings from "../app/(settings)/messaging";
import { rpc } from "./api";
import { queryClient } from "./query";

const foreground = vi.hoisted(() => ({ active: true }));
vi.mock("./api", () => ({
  rpc: vi.fn(),
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space-1",
  subscribeSpaceSelection: () => () => undefined,
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: session.generation,
    headers: { "x-rakazo-space-id": "space-1" },
  }),
}));
vi.mock("./app-foreground", () => ({ useAppForeground: () => foreground.active }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./user-error", () => ({
  errorText: (_: unknown, fallback = "Something went wrong. Try again.") => fallback,
}));
const session = vi.hoisted(() => ({ generation: 0 }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => session.generation,
  subscribeSessionGeneration: () => () => {},
}));
const push = vi.fn();
let blur: (() => void) | undefined;
vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) =>
    useEffect(() => {
      blur = effect() ?? undefined;
      return () => blur?.();
    }, [effect]),
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
    Linking: { openURL: vi.fn() },
  };
});

const responses: Record<string, unknown> = {};
let container: HTMLDivElement;
let root: Root;

// Cache updates reach the screen inside act instead of on a later timer.
notifyManager.setScheduler((callback) => callback());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  foreground.active = true;
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

/** The app goes to the background and returns with the screen still open. */
async function comeBack() {
  foreground.active = false;
  await act(async () => root.render(<MessagingSettings />));
  foreground.active = true;
  await act(async () => root.render(<MessagingSettings />));
}

function listCalls() {
  return vi.mocked(rpc).mock.calls.filter(([path]) => path === "messaging/channels/list").length;
}

it("answers requests and manages conversations by their own ids, then refreshes", async () => {
  await act(async () => root.render(<MessagingSettings />));
  const before = listCalls();

  await press("Family", "Approve");
  expect(rpc).toHaveBeenCalledWith(
    "messaging/channels/respond",
    {
      membershipId: "cm-invited",
      accept: true,
    },
    expect.anything(),
  );
  await press("Family", "Decline");
  expect(rpc).toHaveBeenCalledWith(
    "messaging/channels/respond",
    {
      membershipId: "cm-invited",
      accept: false,
    },
    expect.anything(),
  );
  await press("Dana's Assistant", "Approve");
  expect(rpc).toHaveBeenCalledWith(
    "messaging/connections/respond",
    {
      connectionId: "ac-in",
      accept: true,
    },
    expect.anything(),
  );
  await press("Dana's Assistant", "Decline");
  expect(rpc).toHaveBeenCalledWith(
    "messaging/connections/respond",
    {
      connectionId: "ac-in",
      accept: false,
    },
    expect.anything(),
  );
  await press("Ops", "Leave");
  expect(rpc).toHaveBeenCalledWith(
    "messaging/channels/leave",
    { membershipId: "cm-joined" },
    expect.anything(),
  );
  await press("Sam's Helper", "Revoke");
  expect(rpc).toHaveBeenCalledWith(
    "messaging/connections/revoke",
    { connectionId: "ac-ok" },
    expect.anything(),
  );

  expect(listCalls()).toBe(before + 6);
});

it("says which line to send a link code to", async () => {
  await act(async () => root.render(<MessagingSettings />));
  const imessage = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "iMessage",
  );
  await act(async () => imessage?.click());
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-1" }, expect.anything());
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
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-1" }, expect.anything());
  expect(rpc).not.toHaveBeenCalledWith(
    "messaging/link/start",
    { botId: "bot-2" },
    expect.anything(),
  );
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
  expect(rpc).toHaveBeenCalledWith("messaging/installations/start", {}, expect.anything());
  expect(rpc).not.toHaveBeenCalledWith(
    "messaging/link/start",
    expect.anything(),
    expect.anything(),
  );
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
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-2" }, expect.anything());
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
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-1" }, expect.anything());
  expect(rpc).not.toHaveBeenCalledWith(
    "messaging/installations/start",
    expect.anything(),
    expect.anything(),
  );
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
  expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-2" }, expect.anything());
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

  await comeBack();
  expect(container.textContent).toContain("Family");
  expect(container.textContent).not.toContain("Something went wrong. Try again.");
});

it("keeps a failed action's error when a refresh that was pending then succeeds", async () => {
  await act(async () => root.render(<MessagingSettings />));
  const answer = async (path: string) => (responses[path] ?? { ok: true }) as never;
  let finishRefresh!: Deferred;
  vi.mocked(rpc).mockImplementation(async (path: string) => {
    if (path === "messaging/channels/respond") throw new Error("offline");
    if (path === "bots/list") {
      finishRefresh = deferred();
      await finishRefresh.promise;
    }
    return answer(path);
  });
  await comeBack();

  await press("Family", "Approve");
  expect(container.textContent).toContain("Something went wrong. Try again.");

  await act(async () => finishRefresh.resolve());
  expect(container.textContent).toContain("Something went wrong. Try again.");
});

it.each(["resolve", "reject"] as const)(
  "ignores a late code %s after switching bots",
  async (outcome) => {
    responses["bots/list"] = [
      { id: "bot-1", name: "Chief" },
      { id: "bot-2", name: "Team" },
    ];

    const pending = deferred<unknown>();
    responses["messaging/link/start"] = pending.promise;
    await act(async () => root.render(<MessagingSettings />));
    const click = (text: string) =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === text)!
        .click();
    await act(async () => {
      click("iMessage");
    });
    expect(
      vi.mocked(rpc).mock.calls.filter(([path]) => path === "messaging/link/start"),
    ).toHaveLength(1);
    await act(async () => click("Team"));
    await act(async () => {
      if (outcome === "resolve")
        pending.resolve({
          code: "OLD-CODE",
          expiresAt: new Date(Date.now() + 20_000).toISOString(),
        });
      else pending.reject(new Error("old request failed"));
    });
    expect(container.textContent).not.toContain("OLD-CODE");
    expect(container.textContent).not.toContain("Something went wrong");
    responses["messaging/link/start"] = {
      code: "NEW-CODE",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    };
    await act(async () => click("iMessage"));
    expect(rpc).toHaveBeenLastCalledWith(
      "messaging/link/start",
      { botId: "bot-2" },
      expect.anything(),
    );
    expect(container.textContent).toContain("NEW-CODE");
    expect(rpc).toHaveBeenCalledWith("messaging/link/start", { botId: "bot-2" }, expect.anything());
  },
);

it("does not issue another code while one request is in flight", async () => {
  const pending = deferred<unknown>();
  responses["messaging/link/start"] = pending.promise;
  await act(async () => root.render(<MessagingSettings />));
  const reads = listCalls();
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "iMessage",
  )!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(
    vi.mocked(rpc).mock.calls.filter(([path]) => path === "messaging/link/start"),
  ).toHaveLength(1);
  await act(async () =>
    pending.resolve({ code: "ONE-CODE", expiresAt: new Date(Date.now() + 20_000).toISOString() }),
  );
  expect(container.textContent).toContain("ONE-CODE");
  expect(listCalls()).toBe(reads);
});

it("ignores a code that arrives after leaving settings", async () => {
  const pending = deferred<unknown>();
  responses["messaging/link/start"] = pending.promise;
  await act(async () => root.render(<MessagingSettings />));
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "iMessage")!
      .click(),
  );
  const reads = listCalls();
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () =>
    pending.resolve({
      code: "CLOSED-CODE",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    }),
  );
  expect(listCalls()).toBe(reads);
  expect(container.textContent).toBe("");
});

it.each(["resolve", "reject"] as const)(
  "ignores a late %s after blur without unmount",
  async (outcome) => {
    const pending = deferred<unknown>();
    responses["messaging/link/start"] = pending.promise;
    await act(async () => root.render(<MessagingSettings />));
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "iMessage")!
        .click(),
    );
    const reads = listCalls();
    await act(async () => blur?.());
    await act(async () => {
      if (outcome === "resolve")
        pending.resolve({
          code: "BLURRED-CODE",
          expiresAt: new Date(Date.now() + 20_000).toISOString(),
        });
      else pending.reject(new Error("offline"));
    });
    expect(container.textContent).not.toContain("BLURRED-CODE");
    expect(container.textContent).not.toContain("Something went wrong");
    expect(listCalls()).toBe(reads);
  },
);

it("keeps workspace codes through picker changes and clears them on blur", async () => {
  responses["messaging/status"] = {
    enabled: true,
    providers: ["slack", "sendblue"],
    identities: [],
  };
  responses["bots/list"] = [
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Team" },
  ];
  responses["messaging/installations/list"] = {
    available: true,
    installations: [
      { id: "install-1", provider: "slack", workspaceName: "Workspace", botId: "workspace-bot" },
    ],
  };

  const pending = deferred<unknown>();
  responses["messaging/link/start"] = pending.promise;
  await act(async () => root.render(<MessagingSettings />));
  await press("Slack", "Link DMs");
  const pick = (label: string) =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click();
  await act(async () => pick("Team"));
  await act(async () =>
    pending.resolve({
      code: "WORKSPACE-CODE",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    }),
  );
  expect(container.textContent).toContain("WORKSPACE-CODE");
  expect(rpc).toHaveBeenCalledWith(
    "messaging/link/start",
    { botId: "workspace-bot" },
    expect.anything(),
  );
  await act(async () => pick("Chief"));
  expect(container.textContent).toContain("WORKSPACE-CODE");
  await act(async () => blur?.());
  expect(container.textContent).not.toContain("WORKSPACE-CODE");
});

it("blocks issuance across remounts until the previous request settles", async () => {
  const pending = deferred<unknown>();
  responses["messaging/link/start"] = pending.promise;
  await act(async () => root.render(<MessagingSettings />));
  const connect = () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "iMessage")!
      .click();
  await act(async () => connect());
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<MessagingSettings />));
  await act(async () => connect());
  expect(
    vi.mocked(rpc).mock.calls.filter(([path]) => path === "messaging/link/start"),
  ).toHaveLength(1);
  await act(async () =>
    pending.resolve({
      code: "CLOSED-CODE",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    }),
  );
  expect(container.textContent).not.toContain("CLOSED-CODE");
  responses["messaging/link/start"] = {
    code: "NEW-CODE",
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
  };
  await act(async () => connect());
  expect(
    vi.mocked(rpc).mock.calls.filter(([path]) => path === "messaging/link/start"),
  ).toHaveLength(2);
  expect(container.textContent).toContain("NEW-CODE");
});

it("does not block a new session on the previous session's request", async () => {
  const old = deferred<unknown>();
  responses["messaging/link/start"] = old.promise;
  await act(async () => root.render(<MessagingSettings />));
  const connect = () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "iMessage")!
      .click();
  await act(async () => connect());
  await act(async () => root.unmount());
  root = createRoot(container);
  session.generation += 1;
  responses["messaging/link/start"] = {
    code: "NEW-SESSION",
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
  };
  await act(async () => root.render(<MessagingSettings />));
  await act(async () => connect());
  expect(container.textContent).toContain("NEW-SESSION");
  await act(async () =>
    old.resolve({ code: "OLD-SESSION", expiresAt: new Date(Date.now() + 20_000).toISOString() }),
  );
  expect(container.textContent).not.toContain("OLD-SESSION");
  expect(container.textContent).toContain("NEW-SESSION");
});

it("answers a request once for a double tap", async () => {
  await act(async () => root.render(<MessagingSettings />));
  const answer = deferred<unknown>();
  responses["messaging/channels/respond"] = answer.promise;
  await act(async () => {
    button("Family", "Approve").click();
    button("Family", "Approve").click();
  });
  await act(async () => answer.resolve({ ok: true }));
  expect(
    vi.mocked(rpc).mock.calls.filter(([path]) => path === "messaging/channels/respond"),
  ).toHaveLength(1);
});
