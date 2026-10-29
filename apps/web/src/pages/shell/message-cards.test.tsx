// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  begin: vi.fn(async () => ({ connectionId: "connection", authorizationUrl: null })),
  complete: vi.fn(async () => ({ status: "connected" })),
  mark: vi.fn(async () => ({ ok: true })),
  oauthBegin: vi.fn(async () => ({
    status: "authorization_required" as const,
    authorizationUrl: "https://identity.example.test/authorize",
  })),
  approve: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    connections: { begin: calls.begin, complete: calls.complete },
    onboarding: { appConnected: calls.mark },
    mcp: { oauth: { begin: calls.oauthBegin }, assignments: { approve: calls.approve } },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + (index ? values[index - 1] : "") + part, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { connectMcpOauth } from "../../lib/mcp-connect";
import { AppConnectCard, McpApprovalCard } from "./message-cards";

function popupFlow() {
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    close = vi.fn();
    constructor(public name: string) {
      channels.push(this);
    }
  }
  const popup = { closed: true, close: vi.fn() };
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  return { popup, channels };
}

it("approves the bot after OAuth completes despite a closed-looking popup", async () => {
  vi.useFakeTimers();
  const { channels } = popupFlow();
  calls.approve.mockClear();
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
    expect(host.textContent).toContain("Connecting");
    await act(async () =>
      channels[0]?.onmessage?.({ data: { type: "unrelated" } } as MessageEvent),
    );
    expect(calls.approve).not.toHaveBeenCalled();
    await act(async () =>
      channels[0]?.onmessage?.({ data: { type: "mcp-oauth-complete" } } as MessageEvent),
    );
    expect(calls.approve).toHaveBeenCalledExactlyOnceWith({
      botId: "bot",
      serverId: "server",
      threadId: "thread",
    });
    expect(channels[0]?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("waits until timeout after the popup is closed and cleans up", async () => {
  vi.useFakeTimers();
  const { popup, channels } = popupFlow();
  try {
    const flow = connectMcpOauth("server");
    await vi.advanceTimersByTimeAsync(120_000 - 1);
    expect(popup.close).not.toHaveBeenCalled();
    expect(channels[0]?.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(flow).resolves.toBe("cancelled");
    expect(popup.close).toHaveBeenCalledOnce();
    expect(channels[0]?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
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
    expect(host.querySelector("button")?.textContent).toBe("Authorize");
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
