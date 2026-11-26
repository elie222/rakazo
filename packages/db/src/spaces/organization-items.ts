import { ClientError } from "@rakazo/core";
import { GUEST_ROLE, LIVE_ORGANIZATION } from "../billing/billing.js";
import type { PrismaClient } from "../database/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { availableInSpace, itemSecretIn } from "./availability.js";
import { organizationRole } from "./organization-members.js";

type Scope = { spaceId: string; userId: string };

/**
 * An organization's item: every member's agents can use it in each Space of the organization.
 * Guests, who only belong to Spaces they were invited to, never reach it.
 */
export function organizationItemIn(scope: Scope) {
  return {
    organization: {
      AND: [
        LIVE_ORGANIZATION,
        { spaces: { some: { id: scope.spaceId } } },
        { members: { some: { userId: scope.userId, role: { not: GUEST_ROLE } } } },
      ],
    },
  };
}

/** The managed app connections available to a member in this Space. */
export function connectionIn(scope: Scope) {
  return { OR: [{ spaceId: scope.spaceId, userId: scope.userId }, organizationItemIn(scope)] };
}

/** The MCP servers a member's agents can use in this Space: their own and the organization's. */
export function personalOrOrganizationItemIn(scope: Scope) {
  return { OR: [availableInSpace(scope), organizationItemIn(scope)] };
}

export const mcpServerIn = personalOrOrganizationItemIn;

/** A server's secret, which is the member's own or, for an organization's server, the organization's. */
export function serverSecretIn(scope: Scope) {
  return { OR: [itemSecretIn(scope), organizationItemIn(scope)] };
}

/** The organization of this Space when the member is its owner or an admin, who manage what it shares. */
export async function managedOrganizationId(
  db: Pick<PrismaClient, "space" | "member">,
  scope: Scope,
): Promise<string | null> {
  const space = await db.space.findUnique({
    where: { id: scope.spaceId },
    select: { organizationId: true },
  });
  if (!space) return null;
  const member = await db.member.findFirst({
    where: {
      organizationId: space.organizationId,
      userId: scope.userId,
      role: { not: GUEST_ROLE },
      organization: LIVE_ORGANIZATION,
    },
    select: { role: true },
  });
  return member && organizationRole(member.role) !== "member" ? space.organizationId : null;
}

/** The MCP servers a member can change: their own and, for an admin, the organization's. */
export function personalOrManagedOrganizationItemIn(scope: Scope, organizationId: string | null) {
  return {
    OR: [availableInSpace(scope), ...(organizationId ? [{ organizationId }] : [])],
  };
}

export const mcpServerManagedIn = personalOrManagedOrganizationItemIn;

export async function requireManagedOrganizationId(
  db: Pick<PrismaClient, "space" | "member">,
  scope: Scope,
) {
  const id = await managedOrganizationId(db, scope);
  if (!id) throw new ClientError("FORBIDDEN", "Only organization admins can share items.");
  return id;
}

/**
 * Who owns a server's new secret: the organization for its server, else the member, on the account
 * once the server is available beyond the Space it was added in so every such Space reads it.
 */
export async function serverSecretOwner(
  tx: Pick<Prisma.TransactionClient, "mcpServerSpace">,
  server: { id: string; organizationId: string | null; spaceId: string | null; allSpaces: boolean },
  scope: Scope,
): Promise<{ organizationId: string | null; userId: string | null; spaceId: string | null }> {
  if (server.organizationId)
    return { organizationId: server.organizationId, userId: null, spaceId: null };
  const shared =
    server.allSpaces ||
    server.spaceId !== scope.spaceId ||
    (await tx.mcpServerSpace.count({ where: { serverId: server.id } })) > 0;
  return { organizationId: null, userId: scope.userId, spaceId: shared ? null : scope.spaceId };
}

/** The organization's server at this address, as one URL in any spelling, reachable from this Space. */
export async function organizationServerAt(
  db: Pick<PrismaClient, "mcpServer">,
  scope: Scope,
  endpoint: string,
  exceptId?: string,
): Promise<{ id: string; name: string } | null> {
  const href = (url: string) => (URL.canParse(url) ? new URL(url).href : url);
  const rows = await db.mcpServer.findMany({
    where: {
      ...organizationItemIn(scope),
      endpoint: { not: null },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true, name: true, endpoint: true },
  });
  const found = rows.find((row) => row.endpoint && href(row.endpoint) === href(endpoint));
  return found ? { id: found.id, name: found.name } : null;
}
