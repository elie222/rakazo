import { describe, expect, it } from "vitest";
import { assertMcpRemoteEndpoint } from "./mcp-servers.js";
import type { RouterDeps } from "./router.js";
import { TAILNET_CHECK_NEEDS_BOT, tailnetCheckRoute } from "./routes/tailnet.js";

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

describe("checking a tailnet MCP server while adding it", () => {
  const ACTOR = {
    userId: "alice",
    spaceId: "home",
    email: "alice@example.test",
    isDeploymentOwner: false,
  };
  function routeDeps(botIds: string[] | null) {
    return {
      prisma: {
        tailnetConnection: {
          findUnique: async () => (botIds ? { tag: "tag:rakazo", botIds } : null),
        },
        bot: {
          findFirst: async ({ where }: { where: { id: { in: string[] } } }) =>
            where.id.in.includes("helper") ? { id: "helper" } : null,
        },
      } as never,
      tailnet: {
        service: { available: true, dial: async () => undefined as never },
        serverOrigin: "https://rakazo.example.test",
      } as never,
    };
  }

  it("goes through one of the member's bots allowed on their tailnet", async () => {
    expect(await tailnetCheckRoute(routeDeps(["helper"]), ACTOR, true)).toBeDefined();
  });

  it("asks for a bot with tailnet access when there is none", async () => {
    for (const botIds of [null, [], ["gone"]]) {
      await expect(tailnetCheckRoute(routeDeps(botIds), ACTOR, true)).rejects.toThrow(
        TAILNET_CHECK_NEEDS_BOT,
      );
    }
  });

  it("leaves every other address to the usual checks", async () => {
    expect(await tailnetCheckRoute(routeDeps(null), ACTOR, false)).toBeUndefined();
  });
});
