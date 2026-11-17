// @vitest-environment jsdom
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  begin: vi.fn(async () => ({ connectionId: "connection", authorizationUrl: null })),
  complete: vi.fn(async () => ({ status: "connected" })),
  mark: vi.fn(async () => ({ ok: true })),
  oauthBegin: vi.fn(async () => ({
    status: "authorization_required" as const,
    sessionId: "session",
    authorizationUrl: "https://identity.example.test/authorize",
  })),
  approve: vi.fn(async () => ({ ok: true })),
  choose: vi.fn(),
  dismissFocus: vi.fn(),
}));
vi.mock("../../lib/rpc", () => {
  const rpc = {
    connections: { begin: calls.begin, complete: calls.complete },
    onboarding: {
      appConnected: calls.mark,
      choose: calls.choose,
      dismissFocus: calls.dismissFocus,
    },
    mcp: { oauth: { begin: calls.oauthBegin }, assignments: { approve: calls.approve } },
  };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + (index ? values[index - 1] : "") + part, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { connectMcpOauth } from "../../lib/mcp-connect";
import { AppConnectCard, ChoiceCard, McpApprovalCard } from "./message-cards";

function popupFlow({ focused }: { focused: boolean }) {
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    close = vi.fn();
    constructor(public name: string) {
      channels.push(this);
    }
  }
  // A popup on a COOP provider page reads as closed to the opener.
  const popup = { closed: true, close: vi.fn() };
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
  return { popup, channels };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("approves the bot after OAuth completes while a COOP popup keeps focus", async () => {
  vi.useFakeTimers();
  const { channels } = popupFlow({ focused: false });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <McpApprovalCard
          botId="bot"
          threadId="thread"
          block={{
            kind: "mcp_approval",
            name: "Example",
            serverId: "server",
            transport: "streamable_http",
            endpoint: "https://example.test/mcp",
            needsOAuth: true,
            status: "pending",
          }}
        />,
      ),
    );
    await act(async () => host.querySelector("button")?.click());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(calls.approve).not.toHaveBeenCalled();
    await act(async () =>
      channels[0]?.onmessage?.({
        data: { type: "mcp-oauth-complete", sessionId: "session" },
      } as MessageEvent),
    );
    expect(calls.approve).toHaveBeenCalledExactlyOnceWith({
      botId: "bot",
      serverId: "server",
      threadId: "thread",
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});

it("cancels once the popup is closed and the app has focus again", async () => {
  vi.useFakeTimers();
  const { channels } = popupFlow({ focused: true });
  const flow = connectMcpOauth("server");
  await vi.advanceTimersByTimeAsync(500);
  expect(window.open).toHaveBeenCalledWith(
    "https://identity.example.test/authorize",
    "rakazo-mcp-oauth:session",
    "popup,width=560,height=720",
  );
  await expect(flow).resolves.toBe("cancelled");
  expect(channels[0]?.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("authorizes a card in a normal chat and marks its thread connected", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <AppConnectCard
          botId="bot"
          threadId="normal-chat"
          block={{
            kind: "app_connect",
            connectorId: "fake",
            provider: "gmail",
            name: "Gmail",
            description: "",
            logo: null,
            status: "pending",
          }}
        />,
      ),
    );
    expect(host.querySelector("button")?.textContent).toBe("Connect");
    await act(async () => host.querySelector("button")?.click());
    expect(calls.mark).toHaveBeenCalledWith({
      botId: "bot",
      threadId: "normal-chat",
      connectorId: "fake",
      provider: "gmail",
    });
    expect(host.textContent).toContain("Connected");
    expect(host.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("links OAuth failures in chat to the shared recovery guide without approving the server", async () => {
  calls.oauthBegin.mockRejectedValueOnce(
    Object.assign(new Error("Sign-in configuration mismatch"), {
      code: "MCP_OAUTH_REDIRECT_MISMATCH",
    }),
  );
  const approvalsBefore = calls.approve.mock.calls.length;
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <McpApprovalCard
          botId="bot"
          threadId="thread"
          block={{
            kind: "mcp_approval",
            name: "Example",
            serverId: "server",
            transport: "streamable_http",
            endpoint: "https://example.test/mcp",
            needsOAuth: true,
            status: "pending",
          }}
        />,
      ),
    );
    await act(async () => host.querySelector("button")?.click());
    expect(host.querySelector('[role="alert"] a')?.getAttribute("href")).toBe(
      "https://rakazo.com/docs/troubleshooting/#mcp-oauth-redirect-mismatch",
    );
    expect(calls.approve.mock.calls).toHaveLength(approvalsBefore);
    expect(host.querySelector("button")?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it("rejects OAuth callback failures and clears its timers", async () => {
  vi.useFakeTimers();
  const { channels } = popupFlow({ focused: false });
  const flow = connectMcpOauth("server");
  const rejection = expect(flow).rejects.toThrow("Consent denied");
  await vi.advanceTimersByTimeAsync(0);
  channels[0]?.onmessage?.({
    data: { type: "mcp-oauth-failed", sessionId: "other-session", message: "Unrelated" },
  } as MessageEvent);
  expect(channels[0]?.close).not.toHaveBeenCalled();
  channels[0]?.onmessage?.({
    data: { type: "mcp-oauth-failed", sessionId: "session", message: "Consent denied" },
  } as MessageEvent);
  await rejection;
  expect(channels[0]?.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

describe("the onboarding choice card", () => {
  const onBotChanged = vi.fn<() => Promise<void>>();
  async function renderChoice() {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    calls.choose.mockReset();
    calls.dismissFocus.mockReset();
    onBotChanged.mockReset().mockResolvedValue(undefined);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ChoiceCard
            botId="bot"
            block={{
              kind: "choice",
              question: "Which city?",
              options: [
                { id: "paris", letter: "A", label: "Paris" },
                { id: "rome", letter: "B", label: "Rome" },
              ],
            }}
            onBotChanged={onBotChanged}
          />
        </QueryClientProvider>,
      ),
    );
    const buttons = () => [...host.querySelectorAll("button")];
    return {
      host,
      option: (label: string) => buttons().find((button) => button.textContent?.endsWith(label))!,
      dismiss: () => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!,
      buttons,
      async cleanup() {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  }

  it("sends one answer, holds every control meanwhile, and stays held once the thread is read again", async () => {
    const card = await renderChoice();
    try {
      const choosing = deferred<{ ok: true }>();
      calls.choose.mockReturnValue(choosing.promise);
      await act(async () => {
        card.option("Paris").click();
        card.option("Rome").click();
      });
      expect(calls.choose.mock.calls).toEqual([[{ botId: "bot", optionId: "paris" }]]);
      expect(card.buttons().every((button) => button.disabled)).toBe(true);
      expect(onBotChanged).not.toHaveBeenCalled();

      await act(async () => choosing.resolve({ ok: true }));
      expect(onBotChanged).toHaveBeenCalledOnce();
      expect(card.buttons().every((button) => button.disabled)).toBe(true);
    } finally {
      await card.cleanup();
    }
  });

  it("says why a choice was not saved and offers the options again", async () => {
    const card = await renderChoice();
    try {
      calls.choose.mockRejectedValue({ code: "INTERNAL_SERVER_ERROR" });
      await act(async () => card.option("Paris").click());
      expect(card.host.textContent).toContain("Could not save this choice");
      expect(card.buttons().every((button) => !button.disabled)).toBe(true);
      expect(onBotChanged).not.toHaveBeenCalled();
    } finally {
      await card.cleanup();
    }
  });

  it("says why it could not be dismissed", async () => {
    const card = await renderChoice();
    try {
      calls.dismissFocus.mockRejectedValue({ code: "INTERNAL_SERVER_ERROR" });
      await act(async () => card.dismiss().click());
      expect(card.host.textContent).toContain("Could not dismiss");
      expect(card.dismiss().disabled).toBe(false);
    } finally {
      await card.cleanup();
    }
  });

  it("goes away once dismissed, whether or not the thread can be read again", async () => {
    const card = await renderChoice();
    try {
      calls.dismissFocus.mockResolvedValue({ ok: true });
      onBotChanged.mockRejectedValue(new Error("offline"));
      await act(async () => card.dismiss().click());
      expect(calls.dismissFocus.mock.calls).toEqual([[{ botId: "bot" }]]);
      expect(onBotChanged).toHaveBeenCalledOnce();
      expect(card.host.textContent).toBe("");
    } finally {
      await card.cleanup();
    }
  });
});
