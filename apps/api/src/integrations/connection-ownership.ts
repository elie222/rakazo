import type { Actor, Connection } from "@rakazo/contracts";
import {
  APP_CONNECTION_IN_ORGANIZATION,
  ORGANIZATION_CONNECTION_NAME_TAKEN,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { connectionIn, isUniqueViolation, managedOrganizationId, runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterDeps } from "../router.js";

type ConnectionRow = Prisma.ConnectionGetPayload<Record<string, never>>;

export function connectionDto(row: ConnectionRow, managedId?: string | null): Connection {
  return {
    id: row.id,
    connectorId: row.connectorId,
    provider: row.provider,
    displayName: row.displayName,
    status: row.status as Connection["status"],
    capabilities: [],
    createdAt: row.createdAt.toISOString(),
    ...(row.organizationId
      ? { organization: true, manageable: row.organizationId === managedId }
      : {}),
  };
}

export async function requireConnectionOrganization(
  db: Pick<Prisma.TransactionClient, "space" | "member">,
  actor: Actor,
  expectedId?: string,
): Promise<string> {
  const organizationId = await managedOrganizationId(db, actor);
  if (!organizationId || (expectedId && organizationId !== expectedId))
    throw new ClientError(
      "FORBIDDEN",
      "Only organization owners and admins can manage shared connections.",
    );
  return organizationId;
}

export async function findManagedConnection(
  db: Pick<Prisma.TransactionClient, "connection" | "space" | "member">,
  actor: Actor,
  id: string,
) {
  const row = await db.connection.findFirst({ where: { id, ...connectionIn(actor) } });
  if (row?.organizationId) await requireConnectionOrganization(db, actor, row.organizationId);
  return row;
}

export function organizationAppTaken() {
  return new ClientError(
    "CONFLICT",
    "This app is already connected for the organization.",
    APP_CONNECTION_IN_ORGANIZATION,
  );
}

export function throwConnectionNameConflict(error: unknown): never {
  if (!isUniqueViolation(error)) throw error;
  throw new ClientError(
    "CONFLICT",
    "A connection with this name already exists in the organization.",
    ORGANIZATION_CONNECTION_NAME_TAKEN,
  );
}

export async function publishConnectionChange(
  deps: Pick<RouterDeps, "prisma" | "events">,
  actor: Actor,
  organizationId?: string | null,
) {
  if (!deps.events?.publishSpaceChange) return;
  await bestEffort("publish app connection change", publish());

  async function publish() {
    const spaces = organizationId
      ? await runAsSystem("find the Spaces that share this organization connection", () =>
          deps.prisma.space.findMany({
            where: { organizationId },
            select: { id: true },
          }),
        )
      : [{ id: actor.spaceId }];
    await Promise.all(
      spaces.map(({ id }) => deps.events?.publishSpaceChange?.(id, "integrations")),
    );
  }
}
