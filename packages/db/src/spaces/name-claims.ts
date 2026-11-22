import { ClientError } from "@rakazo/core";
import { runAsSystemInTransaction } from "../database/row-security.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { SpaceAvailability } from "./availability.js";
import { AVAILABILITY_SELECT, spaceAvailability } from "./availability.js";

/** Serializes one owner's writes of a kind across all their spaces, until the transaction ends. */
export function lockOwner(tx: Prisma.TransactionClient, userId: string, scope: string) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${userId}`}, 0))`;
}

function overlaps(a: SpaceAvailability, b: SpaceAvailability): boolean {
  return a.allSpaces || b.allSpaces || a.spaceIds.some((id) => b.spaceIds.includes(id));
}

const CONFLICT_MESSAGE = {
  skill: "A skill with that name already exists in one of these spaces.",
  mcpServer: "An MCP server with that name already exists in one of these spaces.",
} as const;

/** The owner already has a skill or MCP server by this name where the new one would be seen. */
export class NameTakenError extends ClientError {
  constructor(kind: keyof typeof CONFLICT_MESSAGE) {
    super("CONFLICT", CONFLICT_MESSAGE[kind]);
    this.name = "NameTakenError";
  }
}

/**
 * A skill name or MCP server slug must stay unique wherever its owner can see it. The owner's
 * rows in their other spaces are only reachable across tenants, so this reads them explicitly
 * by owner rather than through the current space.
 */
export async function assertNameFreeWhereAvailable(
  tx: Prisma.TransactionClient,
  kind: "skill" | "mcpServer",
  actor: { userId: string },
  name: string,
  availability: SpaceAvailability,
  excludeId?: string,
): Promise<void> {
  // Held until the caller's write commits, so two spaces can't both claim a name at once.
  await lockOwner(tx, actor.userId, `names:${kind}`);
  const read = async () =>
    kind === "skill"
      ? tx.agentSkill.findMany({
          where: {
            userId: actor.userId,
            name: { equals: name, mode: "insensitive" },
            ...(excludeId ? { NOT: { id: excludeId } } : {}),
          },
          select: { spaceId: true, allSpaces: true, availableIn: AVAILABILITY_SELECT },
        })
      : tx.mcpServer.findMany({
          where: {
            userId: actor.userId,
            slug: name,
            ...(excludeId ? { NOT: { id: excludeId } } : {}),
          },
          select: { spaceId: true, allSpaces: true, availableIn: AVAILABILITY_SELECT },
        });
  const rows = await runAsSystemInTransaction(tx, "owner's names across their spaces", read);
  if (rows.some((row) => overlaps(spaceAvailability(row), availability)))
    throw new NameTakenError(kind);
}
