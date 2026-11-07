// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { connectMcpEndpoint } from "./mcp-connect";

const api = vi.hoisted(() => ({ mcp: { servers: { connect: vi.fn() } } }));

vi.mock("./rpc", () => ({ rpc: api }));

const tracker = { name: "Tracker", endpoint: "https://mcp.tracker.example/mcp", botId: "bot-1" };
const popup = { closed: false, close: vi.fn(), location: { href: "about:blank" } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
});

it("opens the sign-in window before asking the server, so the browser allows it", async () => {
  let openedFirst = false;
  api.mcp.servers.connect.mockImplementation(async () => {
    openedFirst = vi.mocked(window.open).mock.calls.length === 1;
    return { server: { id: "tracker" }, signIn: { status: "already_connected" } };
  });

  await connectMcpEndpoint(tracker);

  expect(openedFirst).toBe(true);
  expect(api.mcp.servers.connect).toHaveBeenCalledWith({
    ...tracker,
    redirectUri: `${window.location.origin}/mcp/oauth/callback`,
  });
});

it("closes the sign-in window when no sign-in is needed", async () => {
  api.mcp.servers.connect.mockResolvedValue({
    server: { id: "tracker" },
    signIn: { status: "authorization_not_requested" },
  });

  await expect(connectMcpEndpoint(tracker)).resolves.toBe("authorization_not_requested");
  expect(popup.close).toHaveBeenCalled();
});

it("sends the sign-in window to the provider", async () => {
  api.mcp.servers.connect.mockResolvedValue({
    server: { id: "tracker" },
    signIn: {
      status: "authorization_required",
      sessionId: "session-1",
      authorizationUrl: "https://auth.tracker.example/authorize",
    },
  });

  void connectMcpEndpoint(tracker);

  await vi.waitFor(() =>
    expect(popup.location.href).toBe("https://auth.tracker.example/authorize"),
  );
});

it("closes the sign-in window when the server cannot be added", async () => {
  api.mcp.servers.connect.mockRejectedValue(new Error("Needs an OAuth client ID"));

  await expect(connectMcpEndpoint(tracker)).rejects.toThrow("Needs an OAuth client ID");
  expect(popup.close).toHaveBeenCalled();
});
