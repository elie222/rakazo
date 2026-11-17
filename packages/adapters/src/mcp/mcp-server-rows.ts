import type { Actor, McpServerConfigInput } from "@rakazo/contracts";
import type { McpServer, Prisma } from "@rakazo/db";

/**
 * An MCP server's row and its sealed credentials, as Settings, an agent import and a bot add
 * them. `everywhere` reaches all the owner's Spaces and bots; otherwise it stays in this Space.
 */
export async function insertMcpServerRow(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: McpServerConfigInput,
  stored: { id: string; ciphertext: string } | null,
  options: { everywhere?: boolean } = {},
): Promise<McpServer> {
  if (stored) {
    await tx.secret.create({
      data: {
        id: stored.id,
        userId: actor.userId,
        spaceId: options.everywhere ? null : actor.spaceId,
        kind: "mcp",
        ciphertext: stored.ciphertext,
      },
    });
  }
  return tx.mcpServer.create({
    data: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      allSpaces: options.everywhere ?? false,
      allBots: options.everywhere ?? false,
      slug: input.slug,
      name: input.name,
      description: input.description,
      transport: input.transport,
      endpoint: "endpoint" in input ? input.endpoint : null,
      command: "command" in input ? input.command : null,
      hasArgs: "args" in input && input.args.length > 0,
      env: ("env" in input
        ? Object.fromEntries(Object.keys(input.env).map((key) => [key, true]))
        : {}) as Prisma.InputJsonValue,
      files: Object.fromEntries(
        Object.keys("files" in input ? (input.files ?? {}) : {}).map((key) => [key, true]),
      ) as Prisma.InputJsonValue,
      headers: ("headers" in input
        ? Object.fromEntries(Object.keys(input.headers).map((key) => [key, true]))
        : {}) as Prisma.InputJsonValue,
      secretId: stored?.id,
      enabled: input.enabled,
      verbatimResults: input.verbatimResults,
    },
  });
}
