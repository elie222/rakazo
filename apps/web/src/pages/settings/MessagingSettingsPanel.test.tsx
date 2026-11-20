// @vitest-environment jsdom

import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const messaging = vi.hoisted(() => ({
  status: vi.fn(),
  installations: {
    list: vi.fn(async () => ({ available: false, installations: [] })),
    start: vi.fn(),
    remove: vi.fn(),
  },
  channels: { list: vi.fn(async () => []), respond: vi.fn(), leave: vi.fn() },
  connections: { list: vi.fn(async () => []), respond: vi.fn(), revoke: vi.fn() },
  identities: { unlink: vi.fn(), setBot: vi.fn() },
  link: {
    start: vi.fn(async () => ({
      code: "ABCD-2345",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    })),
  },
}));

const api = vi.hoisted(() => ({
  messaging,
  bots: { list: vi.fn(async () => [{ id: "bot-1", name: "Chief" }]) },
  spaces: { list: vi.fn(async () => ({ current: { externalConversations: [] } })) },
}));
vi.mock("../../lib/query/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("./ExternalConversationSettings", () => ({ ExternalConversationSettings: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      children,
      onClick,
      disabled,
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    Dialog: Pass,
    DialogClose: Pass,
    DialogContent: Pass,
    DialogTitle: Pass,
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuGroup: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    SectionHeading: Pass,
    DropdownMenuTrigger: ({
      children,
      disabled,
      render,
    }: ComponentProps<"button"> & { render?: { props: { "aria-label"?: string } } }) => (
      <button type="button" disabled={disabled} aria-label={render?.props["aria-label"]}>
        {children}
      </button>
    ),
    DropdownMenuSubTrigger: ({ children, disabled }: ComponentProps<"button">) => (
      <button type="button" disabled={disabled}>
        {children}
      </button>
    ),
    DropdownMenuItem: ({ children, onClick, disabled }: ComponentProps<"button">) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
  };
});

import { MessagingSettingsPanel } from "./MessagingSettingsPanel";

const identity = {
  id: "mi-1",
  provider: "telegram",
  address: "424242",
  botId: "bot-1",
  botName: "Chief",
};

function statusWith(identities: (typeof identity)[]) {
  return { enabled: true, providers: ["telegram"], openSignup: false, identities };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function renderOverlay() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MessagingSettingsPanel />
      </QueryClientProvider>,
    ),
  );
  // Let query results reach the screen.
  await act(async () => vi.advanceTimersByTimeAsync(0));
}

beforeEach(() => {
  vi.useFakeTimers();
  messaging.installations.list.mockResolvedValue({ available: false, installations: [] });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
  api.bots.list.mockResolvedValue([{ id: "bot-1", name: "Chief" }]);
  messaging.status.mockReset();
  messaging.channels.list.mockReset();
  messaging.channels.list.mockResolvedValue([]);
  messaging.connections.list.mockReset();
  messaging.connections.list.mockResolvedValue([]);
});

/** The settings row for `app`, or the one also naming `detail`. */
function appRow(app: string, detail = "") {
  const rows = [
    ...container.querySelectorAll<HTMLElement>('[data-testid="messaging-chat-apps"] .px-4'),
  ];
  const row = rows.find(
    (candidate) =>
      candidate.querySelector("p")?.textContent === app &&
      (candidate.textContent ?? "").includes(detail),
  );
  if (!row) throw new Error(`no ${app} row`);
  return row;
}

/** The button labeled `label` on `app`'s row. */
function rowButton(app: string, label: string, detail = "") {
  const button = [...appRow(app, detail).querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`no ${label} on ${app}`);
  return button;
}

function telegramItem() {
  return rowButton("Telegram", "Connect");
}

async function startLink() {
  await renderOverlay();
  await act(async () => telegramItem().click());
  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
}

it("lists a chat app linked from the chat app without reopening the dialog", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  expect(container.textContent).not.toContain("424242");

  // The code is sent from the chat app; the server now reports the identity.
  messaging.status.mockResolvedValue(statusWith([identity]));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.textContent).toContain("424242");
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
});

it("stops polling once the link code expires", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
  const calls = messaging.status.mock.calls.length;

  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(messaging.status.mock.calls.length).toBe(calls);
});

it.each([
  [403, 1],
  [404, 1],
  [503, 4],
])("after a %i status poll, link polls total %i", async (status, polls) => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const calls = messaging.status.mock.calls.length;
  messaging.status.mockRejectedValueOnce(Object.assign(new Error("Refused"), { status }));
  await act(async () => vi.advanceTimersByTimeAsync(12_000));
  expect(messaging.status).toHaveBeenCalledTimes(calls + polls);
});

it("detects a same-address relink to the selected bot", async () => {
  const slackIdentity = { ...identity, provider: "slack" };
  const slackStatus = (identities: (typeof identity)[]) => ({
    ...statusWith(identities),
    providers: ["slack"],
  });
  messaging.status.mockResolvedValue(
    slackStatus([{ ...slackIdentity, botId: "bot-2", botName: "Other" }]),
  );
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [{ id: "install-1", provider: "slack", workspaceName: "Home", botId: "bot-1" }],
  } as never);
  await renderOverlay();
  await act(async () => rowButton("Slack", "Link DMs", "Home").click());
  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
  expect(container.textContent).toContain("424242, Other");

  messaging.status.mockResolvedValue(slackStatus([slackIdentity]));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.textContent).toContain("424242, Chief");
  expect(container.textContent).not.toContain("424242, Other");
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
});

it("ignores links to a different bot", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  messaging.status.mockResolvedValue(statusWith([{ ...identity, botId: "bot-2" }]));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
});

it("keeps the detected identity when refreshing other lists fails", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  messaging.status.mockResolvedValue(statusWith([identity]));
  messaging.channels.list.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.textContent).toContain("424242");
  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
  const calls = messaging.status.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(messaging.status).toHaveBeenCalledTimes(calls);
});

it("waits for a pending poll to settle before scheduling another", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const pending = deferred<ReturnType<typeof statusWith>>();
  messaging.status.mockReturnValueOnce(pending.promise);
  const calls = messaging.status.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(9_000));
  expect(messaging.status).toHaveBeenCalledTimes(calls + 1);

  await act(async () => pending.resolve(statusWith([])));
  await act(async () => vi.advanceTimersByTimeAsync(2_999));
  expect(messaging.status).toHaveBeenCalledTimes(calls + 1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(messaging.status).toHaveBeenCalledTimes(calls + 2);
});

it("ignores a previous code's pending response after issuing a new code", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const pending = deferred<ReturnType<typeof statusWith>>();
  messaging.status.mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  await act(async () => telegramItem().click());
  const calls = messaging.status.mock.calls.length;
  await act(async () => pending.resolve(statusWith([identity])));

  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
  expect(container.textContent).not.toContain("424242");
  expect(messaging.status).toHaveBeenCalledTimes(calls);
});

it("ignores a pending response after expiry", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  await startLink();
  const pending = deferred<ReturnType<typeof statusWith>>();
  messaging.status.mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  const calls = messaging.status.mock.calls.length;
  await act(async () => pending.resolve(statusWith([identity])));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(container.querySelector('[data-testid="messaging-link-code"]')).toBeNull();
  expect(container.textContent).not.toContain("424242");
  expect(messaging.status).toHaveBeenCalledTimes(calls);
});

it("connects Slack to the default bot through workspace authorization", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  messaging.installations.list.mockResolvedValue({ available: true, installations: [] });
  const popup = { opener: window, location: { href: "about:blank" }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as never);
  messaging.installations.start.mockResolvedValue({ url: "https://slack.example.test/authorize" });
  try {
    await renderOverlay();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Connect"]);
    await act(async () => rowButton("Slack", "Connect").click());
    expect(messaging.installations.start).toHaveBeenCalledWith({});
    expect(messaging.link.start).not.toHaveBeenCalled();
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe("https://slack.example.test/authorize");
  } finally {
    open.mockRestore();
  }
});

it("lists Slack and code-linked apps as rows with the same Connect action", async () => {
  messaging.status.mockResolvedValue({
    ...statusWith([]),
    providers: ["slack", "telegram", "teams"],
  });
  messaging.installations.list.mockResolvedValue({ available: true, installations: [] });
  await renderOverlay();
  for (const app of ["Slack", "Telegram", "Microsoft Teams"]) rowButton(app, "Connect");
  expect(container.textContent).not.toContain("teams");
  await act(async () => rowButton("Microsoft Teams", "Connect").click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(
    appRow("Microsoft Teams").querySelector('[data-testid="messaging-link-code"]'),
  ).not.toBeNull();
});

it("asks which bot a chat app links to when there are several", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  api.bots.list.mockResolvedValue([
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Team" },
  ]);
  await renderOverlay();
  await act(async () => rowButton("Telegram", "Team").click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-2" });
  expect(appRow("Telegram").textContent).toContain("ABCD-2345");
});

it("keeps code linking for legacy Slack deployments", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  await renderOverlay();
  await act(async () => rowButton("Slack", "Connect").click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(messaging.installations.start).not.toHaveBeenCalled();
});

it("links DMs to the bot that answers in the workspace", async () => {
  messaging.status.mockResolvedValue({
    ...statusWith([identity]),
    providers: ["slack", "telegram"],
  });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [
      { id: "install-1", provider: "slack", workspaceName: "Example workspace", botId: "bot-2" },
    ],
  } as never);
  api.bots.list.mockResolvedValueOnce([
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Team" },
  ]);
  await renderOverlay();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Link DMs")!
      .click(),
  );
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-2" });
  expect(container.querySelector('[data-testid="messaging-link-code"]')).not.toBeNull();
});

async function reopen() {
  act(() => root.unmount());
  await client.invalidateQueries();
  root = createRoot(container);
}

it("reopens with cached chat apps and refreshes them in the background", async () => {
  messaging.status.mockResolvedValue(statusWith([identity]));
  await renderOverlay();
  expect(container.textContent).toContain("424242");
  await reopen();

  const pending = deferred<ReturnType<typeof statusWith>>();
  messaging.status.mockReturnValueOnce(pending.promise);
  await renderOverlay();
  // Painted from the cache while the refresh is still out.
  expect(container.textContent).toContain("424242");
  await act(async () => pending.resolve(statusWith([])));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(container.textContent).not.toContain("424242");
});

it("says when reopening could not refresh, while still showing cached chat apps", async () => {
  messaging.status.mockResolvedValue(statusWith([identity]));
  await renderOverlay();
  await reopen();

  messaging.status.mockRejectedValue(new Error("offline"));
  await renderOverlay();
  expect(container.textContent).toContain("Couldn't load messaging settings");
  expect(container.textContent).toContain("424242");
});

it("keeps an unlink when an older status read lands after it", async () => {
  messaging.status.mockResolvedValue(statusWith([identity]));
  await renderOverlay();
  await reopen();

  const older = deferred<ReturnType<typeof statusWith>>();
  messaging.status.mockReturnValueOnce(older.promise).mockResolvedValue(statusWith([]));
  messaging.identities.unlink.mockResolvedValue({ ok: true });
  await renderOverlay();
  const unlink = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Unlink"),
  );
  await act(async () => unlink?.click());
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(container.textContent).not.toContain("424242");
  // The read sent before the unlink still reports the identity; it must not come back.
  await act(async () => older.resolve(statusWith([identity])));
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(container.textContent).not.toContain("424242");
});

it("keeps a removed Slack workspace gone when an older read lands after it", async () => {
  const workspace = {
    available: true,
    installations: [
      {
        id: "inst-1",
        provider: "slack",
        workspaceName: "Acme HQ",
        botId: "bot-1",
        botName: "Chief",
      },
    ],
  };
  messaging.status.mockResolvedValue(statusWith([]));
  messaging.installations.list.mockResolvedValue(workspace as never);
  await renderOverlay();
  // The bot's name comes with the workspace: it may live in another space.
  expect(container.textContent).toContain("Acme HQ, Chief");
  await reopen();

  const answerOlder = deferred<typeof workspace>();
  messaging.installations.list
    .mockReturnValueOnce(answerOlder.promise as never)
    .mockResolvedValue({ available: true, installations: [] });
  messaging.installations.remove.mockResolvedValue({ ok: true });
  await renderOverlay();
  const remove = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Disconnect",
  );
  if (!remove) throw new Error("Missing remove button");
  await act(async () => remove.click());
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(container.textContent).not.toContain("Acme HQ");
  await act(async () => answerOlder.resolve(workspace));
  await act(async () => vi.advanceTimersByTimeAsync(20));
  expect(container.textContent).not.toContain("Acme HQ");
});

it("says which line to send the code to when the app has one", async () => {
  messaging.status.mockResolvedValue({
    ...statusWith([]),
    providers: ["sendblue"],
    addresses: { sendblue: "+15550001111" },
  });
  await renderOverlay();
  await act(async () => rowButton("iMessage", "Connect").click());
  expect(container.querySelector('[data-testid="messaging-link-code"]')?.textContent).toContain(
    "+15550001111",
  );
});

it("keeps DM linking available for each connected workspace", async () => {
  messaging.status.mockResolvedValue({
    ...statusWith([{ ...identity, provider: "slack" }]),
    providers: ["slack"],
  });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [
      { id: "install-1", provider: "slack", workspaceName: "First workspace", botId: "bot-1" },
      { id: "install-2", provider: "slack", workspaceName: "Second workspace", botId: "bot-1" },
    ],
  } as never);
  await renderOverlay();
  expect(
    [...container.querySelectorAll("button")].filter((button) => button.textContent === "Link DMs"),
  ).toHaveLength(2);
});

it("lets members link personal DMs without owning the workspace connection", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [],
    personalLinkAvailable: true,
  } as never);
  await renderOverlay();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Link DMs")!
      .click(),
  );
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(messaging.installations.start).not.toHaveBeenCalled();
});

it("keeps other apps usable and withholds Slack when its setup method cannot load", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack", "telegram"] });
  messaging.installations.list.mockRejectedValue(new Error("unavailable"));
  await renderOverlay();
  expect(telegramItem().disabled).toBe(false);
  expect(container.textContent).not.toContain("Slack");
  await act(async () => telegramItem().click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-1" });
});

it("lets a member choose which bot their DMs link to in a teammate's workspace", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [],
    personalLinkAvailable: true,
  } as never);
  api.bots.list.mockResolvedValueOnce([
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Team" },
  ]);
  await renderOverlay();
  // Its own row beside Connect, so each row keeps one control.
  const slackRows = [...container.querySelectorAll('[data-testid="messaging-chat-apps"] .px-4')];
  expect(slackRows.map((row) => row.querySelectorAll(":scope button").length)).toEqual([1, 3]);
  const team = [...slackRows[1]!.querySelectorAll("button")].find((b) => b.textContent === "Team");
  await act(async () => team!.click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-2" });
  expect(messaging.installations.start).not.toHaveBeenCalled();
});

it("keeps a teammate's DM link next to the user's own workspace elsewhere", async () => {
  messaging.status.mockResolvedValue({ ...statusWith([]), providers: ["slack"] });
  messaging.installations.list.mockResolvedValue({
    available: true,
    installations: [
      {
        id: "install-1",
        provider: "slack",
        workspaceName: "Home",
        botId: "bot-2",
        botName: "Team",
      },
    ],
    personalLinkAvailable: true,
  } as never);
  await renderOverlay();
  const links = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Link DMs",
  );
  expect(links).toHaveLength(2);
  await act(async () => links[1]!.click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-1" });
});

it("does not issue another code while one request is in flight", async () => {
  messaging.status.mockResolvedValue(statusWith([]));

  const pending = deferred<{ code: string; expiresAt: string }>();
  messaging.link.start.mockReturnValueOnce(pending.promise);
  await renderOverlay();
  const reads = messaging.status.mock.calls.length;
  await act(async () => {
    telegramItem().click();
    telegramItem().click();
  });
  expect(messaging.link.start).toHaveBeenCalledTimes(1);
  await act(async () =>
    pending.resolve({ code: "ONE-CODE", expiresAt: new Date(Date.now() + 20_000).toISOString() }),
  );
  expect(container.textContent).toContain("ONE-CODE");
  expect(messaging.status).toHaveBeenCalledTimes(reads);
});

it("ignores a code that arrives after the panel closes", async () => {
  messaging.status.mockResolvedValue(statusWith([]));

  const pending = deferred<{ code: string; expiresAt: string }>();
  messaging.link.start.mockReturnValueOnce(pending.promise);
  await renderOverlay();
  await act(async () => telegramItem().click());
  const reads = messaging.status.mock.calls.length;
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () =>
    pending.resolve({
      code: "CLOSED-CODE",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    }),
  );
  expect(messaging.status).toHaveBeenCalledTimes(reads);
  expect(container.textContent).toBe("");
});

it("blocks issuance across remounts until the previous request settles", async () => {
  messaging.status.mockResolvedValue(statusWith([]));
  const pending = deferred<{ code: string; expiresAt: string }>();
  messaging.link.start.mockReturnValueOnce(pending.promise);
  await renderOverlay();
  await act(async () => telegramItem().click());
  await act(async () => root.unmount());
  root = createRoot(container);
  await renderOverlay();
  expect(telegramItem().disabled).toBe(true);
  await act(async () => telegramItem().click());
  expect(messaging.link.start).toHaveBeenCalledTimes(1);
  await act(async () =>
    pending.resolve({
      code: "CLOSED-CODE",
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    }),
  );
  expect(container.textContent).not.toContain("CLOSED-CODE");
  expect(telegramItem().disabled).toBe(false);
  await act(async () => telegramItem().click());
  expect(messaging.link.start).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("ABCD-2345");
});

it("moves a linked app to another bot with a code instead of unlinking it", async () => {
  messaging.status.mockResolvedValue(statusWith([identity]));
  api.bots.list.mockResolvedValue([
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Team" },
  ]);
  await renderOverlay();
  // One control per row: the row's actions sit in its options menu.
  const [options] = appRow("Telegram").querySelectorAll("button");
  expect(options?.getAttribute("aria-label")).toBe("Options for Telegram");
  expect(rowButton("Telegram", "Change bot")).toBeDefined();
  // Chief already answers Telegram.
  expect(rowButton("Telegram", "Chief").disabled).toBe(true);
  await act(async () => rowButton("Telegram", "Team").click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-2" });
  expect(messaging.identities.unlink).not.toHaveBeenCalled();
  expect(appRow("Telegram").textContent).toContain("ABCD-2345");
});

it("shows bots already linked elsewhere as unavailable", async () => {
  messaging.status.mockResolvedValue({
    ...statusWith([identity]),
    providers: ["telegram", "whatsapp"],
  });
  await renderOverlay();
  // The only bot answers Telegram: Connect still opens the menu, which says why.
  expect(rowButton("WhatsApp", "Connect").disabled).toBe(false);
  expect(rowButton("WhatsApp", "Chief").disabled).toBe(true);
});

it("links a free bot when another is already linked elsewhere", async () => {
  messaging.status.mockResolvedValue({
    ...statusWith([identity]),
    providers: ["telegram", "whatsapp"],
  });
  api.bots.list.mockResolvedValue([
    { id: "bot-1", name: "Chief" },
    { id: "bot-2", name: "Team" },
  ]);
  await renderOverlay();
  await act(async () => rowButton("WhatsApp", "Team").click());
  expect(messaging.link.start).toHaveBeenCalledWith({ botId: "bot-2" });
});

it("says what each request asks and answers it by its own id", async () => {
  messaging.status.mockResolvedValue(statusWith([identity]));
  messaging.channels.list.mockResolvedValue([
    {
      id: "cm-1",
      channelId: "ch-1",
      identityId: "mi-1",
      provider: "telegram",
      name: "Family",
      status: "invited",
      memberCount: 3,
    },
  ] as never);
  messaging.connections.list.mockResolvedValue([
    {
      id: "ac-1",
      botId: "bot-1",
      peerBotName: "Assistant",
      peerOwnerLabel: "Dana",
      status: "pending",
      incoming: true,
    },
  ] as never);
  await renderOverlay();

  const request = (text: string) => {
    const row = [...container.querySelectorAll("li")].find((item) =>
      item.textContent?.startsWith(text),
    );
    if (!row) throw new Error(`no request ${text}`);
    return row;
  };
  const invite = request("Chief was invited to Family");
  expect(invite.textContent).toContain("Telegram group");
  const connection = request("Dana's Assistant wants to connect to Chief");

  await act(async () => [...invite.querySelectorAll("button")][0]?.click());
  expect(messaging.channels.respond).toHaveBeenCalledWith({ membershipId: "cm-1", accept: true });
  const [allow, decline] = [...connection.querySelectorAll("button")];
  expect([allow?.textContent, decline?.textContent]).toEqual(["Allow", "Decline"]);
  await act(async () => decline?.click());
  expect(messaging.connections.respond).toHaveBeenCalledWith({
    connectionId: "ac-1",
    accept: false,
  });
});
