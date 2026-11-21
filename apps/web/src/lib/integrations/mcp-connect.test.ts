// @vitest-environment jsdom
import type { RakazoDesktopMcpOAuthCallback, RakazoDesktopOAuthCallback } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { connectMcpEndpoint, connectMcpOauth, MCP_OAUTH_CHANNEL } from "./mcp-connect";

const rpcMock = vi.hoisted(() => ({
  mcp: { servers: { connect: vi.fn() }, oauth: { begin: vi.fn(), complete: vi.fn() } },
}));
vi.mock("../query/rpc", () => ({ rpc: rpcMock, rpcForSpace: () => rpcMock }));

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
  rpcMock.mcp.servers.connect.mockReset().mockResolvedValue({
    server: { id: "clx456" },
    signIn: { status: "authorization_required", sessionId: "session-1", authorizationUrl },
  });
});

it("gives the desktop shell a per-server sign-in window and completes its captured code once", async () => {
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

    // The shell can report one callback twice; the session completes only once.
    captured?.({ serverId: "clx123", code: "code-1", state: "session-1" });
    captured?.({ serverId: "clx123", code: "code-1", state: "session-1" });
    await expect(connecting).resolves.toBe("connected");
    expect(rpcMock.mcp.oauth.complete).toHaveBeenCalledOnce();
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

it("opens a catalog server's desktop sign-in window once the server exists", async () => {
  let captured: ((callback: RakazoDesktopMcpOAuthCallback) => void) | undefined;
  window.rakazoDesktop = {
    platform: "darwin",
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
    const connecting = connectMcpEndpoint({
      name: "Tracker",
      endpoint: "https://mcp.tracker.example/mcp",
      botId: "bot-1",
    });
    await vi.waitFor(() => expect(captured).toBeTypeOf("function"));
    expect(rpcMock.mcp.servers.connect).toHaveBeenCalledWith({
      name: "Tracker",
      endpoint: "https://mcp.tracker.example/mcp",
      botId: "bot-1",
      redirectUri: `${window.location.origin}/mcp/oauth/callback`,
    });
    expect(window.open).toHaveBeenCalledWith(
      authorizationUrl,
      "rakazo-mcp-signin:clx456",
      "popup,width=560,height=720",
    );

    captured?.({ serverId: "clx456", code: "code-1", state: "session-1" });
    await expect(connecting).resolves.toBe("connected");
  } finally {
    delete window.rakazoDesktop;
  }
});

it("returns a catalog server that needs no sign-in without opening a window", async () => {
  rpcMock.mcp.servers.connect.mockResolvedValue({
    server: { id: "clx456" },
    signIn: { status: "authorization_not_requested" },
  });
  const open = vi.spyOn(window, "open");

  await expect(
    connectMcpEndpoint({ name: "Docs", endpoint: "https://docs.example/mcp" }),
  ).resolves.toBe("authorization_not_requested");
  expect(open).not.toHaveBeenCalled();
});

it("lets the desktop shell finish a sign-in the provider sent to a loopback address", async () => {
  let loopback: ((callback: RakazoDesktopOAuthCallback) => void) | undefined;
  const releaseLoopback = vi.fn();
  const releaseCallback = vi.fn();
  window.rakazoDesktop = {
    platform: "win32",
    mcpBrowser: { clear: vi.fn(), onOAuthCallback: () => releaseCallback },
    oauth: {
      onCallback: (listener: (callback: RakazoDesktopOAuthCallback) => void) => {
        loopback = listener;
        return releaseLoopback;
      },
    },
  } as unknown as NonNullable<Window["rakazoDesktop"]>;
  openPopup();

  try {
    const connecting = connectMcpOauth("clx123");
    await vi.waitFor(() => expect(loopback).toBeTypeOf("function"));
    expect(rpcMock.mcp.oauth.begin).toHaveBeenCalledWith({
      serverId: "clx123",
      redirectUri: `${window.location.origin}/mcp/oauth/callback`,
      capturesLoopback: true,
    });

    // Another sign-in's loopback code, or one without a state, is not this session's.
    loopback?.({ code: "code-0", state: "session-0" });
    loopback?.({ code: "code-0" });
    expect(rpcMock.mcp.oauth.complete).not.toHaveBeenCalled();

    loopback?.({ code: "code-1", state: "session-1" });
    loopback?.({ code: "code-1", state: "session-1" });
    await expect(connecting).resolves.toBe("connected");
    expect(rpcMock.mcp.oauth.complete).toHaveBeenCalledOnce();
    expect(rpcMock.mcp.oauth.complete).toHaveBeenCalledWith({
      sessionId: "session-1",
      code: "code-1",
      state: "session-1",
    });
    expect(releaseLoopback).toHaveBeenCalled();
    expect(releaseCallback).toHaveBeenCalled();
  } finally {
    delete window.rakazoDesktop;
  }
});

it("does not offer a loopback redirect from a browser or an older desktop app", async () => {
  openPopup();
  void connectMcpOauth("clx123").catch(() => undefined);
  await vi.waitFor(() => expect(rpcMock.mcp.oauth.begin).toHaveBeenCalledOnce());
  expect(rpcMock.mcp.oauth.begin.mock.calls[0]?.[0].capturesLoopback).toBeUndefined();

  window.rakazoDesktop = {
    platform: "darwin",
    mcpBrowser: { clear: vi.fn(), onOAuthCallback: () => () => undefined },
  } as unknown as NonNullable<Window["rakazoDesktop"]>;
  try {
    void connectMcpOauth("clx123").catch(() => undefined);
    await vi.waitFor(() => expect(rpcMock.mcp.oauth.begin).toHaveBeenCalledTimes(2));
    expect(rpcMock.mcp.oauth.begin.mock.calls[1]?.[0].capturesLoopback).toBeUndefined();
  } finally {
    delete window.rakazoDesktop;
  }
});
