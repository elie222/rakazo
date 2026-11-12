import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { connectDeploymentApp, deploymentAppCatalog } from "./deployment-apps.js";
import type { RouterContext } from "./routes/context.js";

const actor: Actor = {
  userId: "user-a",
  spaceId: "space-a",
  email: "test@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    $executeRaw: vi.fn(),
    mcpServer: {
      findMany: vi.fn(async ({ where }) => rows.filter((row) => row.userId === where.userId)),
      findFirst: vi.fn(async ({ where }) =>
        rows.find(
          (row) => row.userId === where.userId && row.deploymentAppId === where.deploymentAppId,
        ),
      ),
      update: vi.fn(async ({ where, data }) =>
        Object.assign(rows.find((row) => row.id === where.id)!, data),
      ),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  const put = vi.fn(async () => ({ id: "secret-id", ciphertext: "encrypted-reference" }));
  const insertMcpServer = vi.fn(async (_tx, owner, config) => {
    const row = {
      id: `server-${rows.length}`,
      userId: owner.userId,
      spaceId: owner.spaceId,
      enabled: true,
      ...config,
    };
    rows.push(row);
    return row;
  });
  const ctx = {
    deps: {
      prisma,
      secrets: { put },
      env: {
        deploymentApps: JSON.stringify({
          drive: { clientId: "fake-client", clientSecret: "fake-secret" },
        }),
        mcpStdioEnabled: true,
        mcpStdioAllowedCommands: ["/app/infra/compose/drive-mcp"],
      },
    },
    insertMcpServer,
    mcpOAuth: { summaryFor: vi.fn(async () => ({ status: "connected" })) },
  } as unknown as RouterContext;
  return { ctx, put, rows, prisma, insertMcpServer };
}

describe("deployment apps", () => {
  it("publishes only public metadata, including missing server setup", async () => {
    const { ctx } = fixture();
    const catalog = await deploymentAppCatalog(ctx, actor);
    expect(catalog[0]).toMatchObject({ mcpAppId: "drive", connected: false, needsSetup: false });
    expect(JSON.stringify(catalog)).not.toContain("fake-secret");
    expect(JSON.stringify(catalog)).not.toContain("fake-client");
    ctx.deps.env.deploymentApps = undefined;
    expect((await deploymentAppCatalog(ctx, actor))[0]?.needsSetup).toBe(true);
    await expect(connectDeploymentApp(ctx, actor, "drive")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("rejects unknown apps and disabled executable support", async () => {
    const { ctx, put } = fixture();
    await expect(connectDeploymentApp(ctx, actor, "arbitrary-command")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    ctx.deps.env.mcpStdioAllowedCommands = [];
    await expect(connectDeploymentApp(ctx, actor, "drive")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("lets a non-admin connect the bundled command and reuses only their own connection", async () => {
    const { ctx, put, rows, insertMcpServer } = fixture();
    const first = await connectDeploymentApp(ctx, actor, "drive");
    expect(await connectDeploymentApp(ctx, actor, "drive")).toEqual(first);
    expect(put).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ userId: actor.userId, allBots: false });
    expect(insertMcpServer.mock.calls[0]?.[2]).toMatchObject({
      command: "/app/infra/compose/drive-mcp",
      env: { ACCESS_TOKEN: "{{oauth.access_token}}" },
    });
    const other = { ...actor, userId: "user-b" };
    expect(await connectDeploymentApp(ctx, other, "drive")).not.toEqual(first);
    expect(put).toHaveBeenCalledTimes(2);
    const catalog = await deploymentAppCatalog(ctx, other);
    expect(catalog[0]?.mcpServerId).not.toBe(first.serverId);
  });
});
