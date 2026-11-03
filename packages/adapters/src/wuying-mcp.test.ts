import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSession } from "./mcp-transport.js";
import { WuyingMcpTools } from "./wuying-sandbox.js";

const signal = new AbortController().signal;
const token = "fake-gateway-token";
const tools = () => new WuyingMcpTools({ url: "https://gateway.example.test/mcp", token });
afterEach(() => vi.restoreAllMocks());

describe("Wuying gateway credential handling", () => {
  it("does not propagate transport errors that echo credentials", async () => {
    const connect = vi
      .spyOn(McpSession.prototype, "connectRemote")
      .mockRejectedValue(new Error(token));
    const unreachable = tools().call("env_get", {}, signal);
    await expect(unreachable).rejects.toThrow("The computer gateway could not be reached");
    await expect(unreachable).rejects.not.toHaveProperty("cause");
    connect.mockResolvedValue({ transport: "streamable-http", usedFallback: false });
    vi.spyOn(McpSession.prototype, "callTool").mockRejectedValue(new Error(token));
    vi.spyOn(McpSession.prototype, "close").mockResolvedValue(undefined);
    const unanswered = tools().call("env_get", {}, signal);
    await expect(unanswered).rejects.toThrow("The computer did not answer env_get");
    await expect(unanswered).rejects.not.toHaveProperty("cause");
  });

  it("keeps only the not_found code from a tool error, with no echoed body or token", async () => {
    vi.spyOn(McpSession.prototype, "connectRemote").mockResolvedValue({
      transport: "streamable-http",
      usedFallback: false,
    });
    vi.spyOn(McpSession.prototype, "callTool").mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: token }],
      structuredContent: { error: { code: "not_found", message: token } },
    });
    await expect(tools().call("fs_info", {}, signal)).rejects.toMatchObject({
      code: "not_found",
      message: "fs_info failed",
    });
  });
});
