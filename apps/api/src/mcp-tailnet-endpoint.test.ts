import { describe, expect, it } from "vitest";
import { assertMcpRemoteEndpoint } from "./mcp-servers.js";
import type { RouterDeps } from "./router.js";

function deps(available: boolean | undefined) {
  return {
    env: { mcpAllowPrivateEndpoint: false },
    remoteConnectors: { resolveHostname: async () => [] },
    tailnet:
      available === undefined
        ? undefined
        : { service: { available }, serverOrigin: "https://rakazo.example.test" },
  } as unknown as Pick<RouterDeps, "remoteConnectors" | "env" | "tailnet">;
}

describe("MCP server URLs on a tailnet", () => {
  it.each(["http://mcp.tail1234.ts.net/mcp", "https://100.101.102.103:3000/mcp"])(
    "accepts %s when bots can reach the member's tailnet",
    async (endpoint) => {
      await expect(
        assertMcpRemoteEndpoint(endpoint, deps(true), { server: true }),
      ).resolves.toBeUndefined();
    },
  );

  it("still refuses credentials in the URL", async () => {
    await expect(
      assertMcpRemoteEndpoint("https://user:pass@mcp.tail1234.ts.net/mcp", deps(true), {
        server: true,
      }),
    ).rejects.toThrow("credentials");
  });

  it.each([
    ["a server that can't run bot nodes", deps(false), { server: true }],
    ["a server without tailnet access", deps(undefined), { server: true }],
    ["a URL the server itself fetches", deps(true), {}],
  ])("refuses a tailnet address on %s", async (_case, routerDeps, options) => {
    await expect(
      assertMcpRemoteEndpoint("http://100.101.102.103/mcp", routerDeps, options),
    ).rejects.toThrow();
  });
});
