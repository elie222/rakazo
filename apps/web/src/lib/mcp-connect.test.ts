// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { connectMcpEndpoint } from "./mcp-connect";

const api = vi.hoisted(() => ({
  mcp: {
    servers: { list: vi.fn(), create: vi.fn() },
    oauth: { begin: vi.fn() },
    assignments: { approve: vi.fn() },
  },
}));

vi.mock("./rpc", () => ({ rpc: api }));

const tracker = { name: "Tracker", endpoint: "https://mcp.tracker.example/mcp", botId: "bot-1" };

beforeEach(() => {
  vi.resetAllMocks();
  api.mcp.servers.list.mockResolvedValue([
    { id: "tracker", enabled: true, endpoint: tracker.endpoint },
  ]);
});

it("gives the bot a server it is already signed in to", async () => {
  api.mcp.oauth.begin.mockResolvedValue({ status: "already_connected" });

  await expect(connectMcpEndpoint(tracker)).resolves.toBe("already_connected");
  expect(api.mcp.assignments.approve).toHaveBeenCalledWith({
    botId: "bot-1",
    serverId: "tracker",
  });
});

it("does not give the bot a server whose sign-in never happened", async () => {
  api.mcp.oauth.begin.mockResolvedValue({ status: "authorization_not_requested" });

  await expect(connectMcpEndpoint(tracker)).resolves.toBe("authorization_not_requested");
  expect(api.mcp.assignments.approve).not.toHaveBeenCalled();
});
