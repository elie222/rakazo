// @vitest-environment jsdom
import type { RakazoDesktopMcpOAuthCallback } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { connectMcpOauth, MCP_OAUTH_CHANNEL } from "./mcp-connect";

const rpcMock = vi.hoisted(() => ({
  mcp: { oauth: { begin: vi.fn(), complete: vi.fn() } },
}));
vi.mock("./rpc", () => ({ rpc: rpcMock, rpcForSpace: () => rpcMock }));

const authorizationUrl = "https://provider.example.com/authorize?state=session-1";

function openPopup() {
  const value = { closed: false, close: vi.fn(() => (value.closed = true)) };
  vi.spyOn(window, "open").mockReturnValue(value as unknown as Window);
  return value;
}

beforeEach(() => {
  vi.restoreAllMocks();
  rpcMock.mcp.oauth.begin.mockReset().mockResolvedValue({
    status: "authorization_required",
    sessionId: "session-1",
    authorizationUrl,
  });
  rpcMock.mcp.oauth.complete.mockReset().mockResolvedValue({ ok: true });
});

it("gives the desktop shell a per-server sign-in window and completes its captured code", async () => {
  let captured: ((callback: RakazoDesktopMcpOAuthCallback) => void) | undefined;
  const unsubscribe = vi.fn();
  window.rakazoDesktop = {
    platform: "darwin",
    mcpBrowser: {
      clear: vi.fn(),
      onOAuthCallback: (listener: (callback: RakazoDesktopMcpOAuthCallback) => void) => {
        captured = listener;
        return unsubscribe;
      },
    },
  } as unknown as NonNullable<Window["rakazoDesktop"]>;
  openPopup();

  try {
    const connecting = connectMcpOauth("clx123");
    await vi.waitFor(() => expect(captured).toBeTypeOf("function"));
    expect(window.open).toHaveBeenCalledWith(
      authorizationUrl,
      "rakazo-mcp-signin:clx123",
      "popup,width=560,height=720",
    );

    // Another server's code, and a stale attempt's state, are not this sign-in.
    captured?.({ serverId: "other", code: "code-0", state: "session-1" });
    captured?.({ serverId: "clx123", code: "code-0", state: "session-0" });
    expect(rpcMock.mcp.oauth.complete).not.toHaveBeenCalled();

    captured?.({ serverId: "clx123", code: "code-1", state: "session-1" });
    await expect(connecting).resolves.toBe("connected");
    expect(rpcMock.mcp.oauth.complete).toHaveBeenCalledWith({
      sessionId: "session-1",
      code: "code-1",
      state: "session-1",
    });
    expect(unsubscribe).toHaveBeenCalled();
  } finally {
    delete window.rakazoDesktop;
  }
});

it("keeps the browser flow's session-named window and callback page", async () => {
  openPopup();

  const connecting = connectMcpOauth("clx123");
  await vi.waitFor(() =>
    expect(window.open).toHaveBeenCalledWith(
      authorizationUrl,
      `${MCP_OAUTH_CHANNEL}:session-1`,
      "popup,width=560,height=720",
    ),
  );
  const callbackPage = new BroadcastChannel(MCP_OAUTH_CHANNEL);
  callbackPage.postMessage({ type: "mcp-oauth-complete", sessionId: "session-1" });
  callbackPage.close();

  await expect(connecting).resolves.toBe("connected");
  expect(rpcMock.mcp.oauth.complete).not.toHaveBeenCalled();
});

it("treats a refusal of this attempt as a cancel and ignores a stale one", async () => {
  let captured: ((callback: RakazoDesktopMcpOAuthCallback) => void) | undefined;
  window.rakazoDesktop = {
    platform: "linux",
    mcpBrowser: {
      clear: vi.fn(),
      onOAuthCallback: (listener: (callback: RakazoDesktopMcpOAuthCallback) => void) => {
        captured = listener;
        return () => undefined;
      },
    },
  } as unknown as NonNullable<Window["rakazoDesktop"]>;
  openPopup();

  try {
    const connecting = connectMcpOauth("clx123");
    await vi.waitFor(() => expect(captured).toBeTypeOf("function"));
    captured?.({ serverId: "clx123", code: null, state: "session-0" });
    captured?.({ serverId: "clx123", code: null, state: "session-1" });

    await expect(connecting).resolves.toBe("cancelled");
    expect(rpcMock.mcp.oauth.complete).not.toHaveBeenCalled();
  } finally {
    delete window.rakazoDesktop;
  }
});
