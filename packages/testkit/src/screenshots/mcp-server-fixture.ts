import type { PrismaClient } from "@rakazo/db";

/**
 * A working remote MCP server two bots can use, for the integrations and MCP server screens. It
 * keeps tool results whole, so its Advanced row shows a setting in use.
 */
export async function ensureMcpServer(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; botIds: string[] },
) {
  const owner = { spaceId: input.spaceId, userId: input.userId };
  const server = await prisma.mcpServer.upsert({
    where: { spaceId_userId_slug: { ...owner, slug: "issue-tracker" } },
    create: {
      ...owner,
      slug: "issue-tracker",
      name: "Issue tracker",
      transport: "streamable_http",
      endpoint: "https://tracker.example.com/mcp",
      healthStatus: "ok",
      healthToolCount: 4,
      healthCheckedAt: new Date(),
      verbatimResults: true,
    },
    update: {},
  });
  await prisma.botMcpServer.createMany({
    data: input.botIds.map((botId) => ({ ...owner, botId, serverId: server.id })),
    skipDuplicates: true,
  });
}
