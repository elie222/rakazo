import { createRouterClient } from "@orpc/server";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

/** The MCP server names the address the browser is sent to; these tests vary only that answer. */
function harness(signIn: unknown) {
  const begin = vi.fn(async () => signIn);
  const summaryFor = vi.fn(async () => ({ status: "none", clientId: null, credential: true }));
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ email: "owner@rakazo.test", emailVerified: true })) },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "owner-1" }) },
    mcpServer: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    mcpServerSpace: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    secrets: { put: vi.fn(), load: vi.fn() },
    mcpOAuth: { begin, summaryFor, summaryForCiphertext: summaryFor },
    mcp: { probe: vi.fn() },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), {
    context: {
      actor: {
        spaceId: "workspace-1",
        userId: "owner-1",
        email: "owner@rakazo.test",
        isDeploymentOwner: true,
      },
    } as never,
  });
  return { begin, client };
}

describe("mcp.oauth.begin", () => {
  it.each(["javascript:alert(1)", "data:text/html,<script>x</script>", "custom-app:signin"])(
    "refuses a sign-in URL that is not http(s): %s",
    async (authorizationUrl) => {
      const { client } = harness({
        status: "authorization_required",
        sessionId: "session-1",
        authorizationUrl,
      });
      await expect(client.mcp.oauth.begin({ serverId: "server-1" })).rejects.toMatchObject({
        kind: "SERVICE_UNAVAILABLE",
        message: "The server returned an invalid sign-in URL.",
      });
    },
  );

  it("hands back the normalized web URL it checked", async () => {
    const { client } = harness({
      status: "authorization_required",
      sessionId: "session-1",
      authorizationUrl: "  https://mcp.example/authorize?state=a b  ",
    });
    await expect(client.mcp.oauth.begin({ serverId: "server-1" })).resolves.toEqual({
      status: "authorization_required",
      sessionId: "session-1",
      authorizationUrl: "https://mcp.example/authorize?state=a%20b",
    });
  });

  it("passes an answer that needs no sign-in straight through", async () => {
    const { client } = harness({ status: "already_connected" });
    await expect(client.mcp.oauth.begin({ serverId: "server-1" })).resolves.toEqual({
      status: "already_connected",
    });
  });
});
