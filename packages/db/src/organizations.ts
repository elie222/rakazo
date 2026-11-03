import { randomUUID } from "node:crypto";
import type { Actor, OrganizationList } from "@rakazo/contracts";
import { createOrganizationWithDefaultSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";
import {
  claimSpaceForDeletion,
  normalizeSpaceName,
  SpaceDeletionInProgressError,
} from "./spaces.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const MAX_ORGANIZATIONS_PER_USER = 10;

export class OrganizationLimitError extends Error {
  constructor() {
    super(`You can have up to ${MAX_ORGANIZATIONS_PER_USER} organizations.`);
    this.name = "OrganizationLimitError";
  }
}

export class CannotDeleteLastOrganizationError extends Error {
  constructor() {
    super("Your only organization cannot be deleted");
    this.name = "CannotDeleteLastOrganizationError";
  }
}

const OWNER = { contains: "owner" };

/** Organizations whose default Space is being deleted are on their way out. */
const LIVE: Prisma.OrganizationWhereInput = {
  spaces: { some: { isDefault: true, deletingAt: null } },
};

/** Serializes one user's organization creates and deletes, so the cap and last-org rule hold. */
async function lockUserOrganizations(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`organizations:${userId}`}, 0))::text AS "lock"
  `);
}

export async function createOrganizationForUser(
  prisma: PrismaClient,
  input: { userId: string; name: string },
): Promise<{ id: string; name: string; defaultSpaceId: string }> {
  const name = normalizeSpaceName(input.name);
  const orgId = randomUUID();
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockUserOrganizations(tx, input.userId);
      const owned = await tx.member.count({ where: { userId: input.userId, role: OWNER } });
      if (owned >= MAX_ORGANIZATIONS_PER_USER) throw new OrganizationLimitError();
      await createOrganizationWithDefaultSpace(tx, {
        userId: input.userId,
        orgId,
        name,
        slug: `org-${randomUUID()}`,
      });
    }),
  );
  return { id: orgId, name, defaultSpaceId: orgId };
}

export async function listOwnedOrganizations(
  prisma: PrismaClient,
  actor: Pick<Actor, "userId" | "spaceId">,
): Promise<OrganizationList> {
  const [current, organizations, memberships] = await Promise.all([
    prisma.space.findUnique({ where: { id: actor.spaceId }, select: { organizationId: true } }),
    prisma.organization.findMany({
      where: { members: { some: { userId: actor.userId, role: OWNER } }, ...LIVE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        spaces: { where: { isDefault: true }, select: { id: true }, take: 1 },
      },
    }),
    prisma.spaceMember.findMany({
      where: { userId: actor.userId, space: { deletingAt: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { spaceId: true, organizationId: true },
    }),
  ]);
  if (!current) throw new IsolationError();
  return {
    activeOrganizationId: current.organizationId,
    organizations: organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      defaultSpaceId: organization.spaces[0]!.id,
      spaceIds: memberships
        .filter((membership) => membership.organizationId === organization.id)
        .map((membership) => membership.spaceId),
    })),
  };
}

export async function renameOrganization(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; name: string },
): Promise<{ id: string; name: string }> {
  const name = normalizeSpaceName(input.name);
  const { count } = await prisma.organization.updateMany({
    where: {
      id: input.organizationId,
      members: { some: { userId: input.userId, role: OWNER } },
      ...LIVE,
    },
    data: { name },
  });
  if (count === 0) throw new IsolationError();
  return { id: input.organizationId, name };
}

/**
 * Claims every Space of an organization the user owns, unless it is the last one they own, which
 * hides it from the list. A retry keeps the claims it already holds.
 */
export async function claimOrganizationForDeletion(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string },
): Promise<{ claimId: string; spaceIds: string[] }> {
  const claimId = `organization-deletion:${input.organizationId}`;
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockUserOrganizations(tx, input.userId);
        const [owner, others] = await Promise.all([
          tx.member.findFirst({
            where: { organizationId: input.organizationId, userId: input.userId, role: OWNER },
            select: { id: true },
          }),
          tx.member.count({
            where: {
              userId: input.userId,
              role: OWNER,
              organizationId: { not: input.organizationId },
              organization: LIVE,
            },
          }),
        ]);
        if (!owner) throw new IsolationError();
        if (others === 0) throw new CannotDeleteLastOrganizationError();
        const spaces = await tx.space.findMany({
          where: { organizationId: input.organizationId },
          select: { id: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        for (const { id } of spaces) await claimSpaceForDeletion(tx, id, claimId);
        return { claimId, spaceIds: spaces.map((space) => space.id) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Deletes the organization once its Spaces are gone; the rest of its rows go by cascade. */
export async function deleteEmptyOrganization(
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> {
  const { count } = await prisma.organization.deleteMany({
    where: { id: organizationId, spaces: { none: {} } },
  });
  // A Space created after the claim; deleting again claims and tears it down.
  if (count === 0 && (await prisma.organization.findUnique({ where: { id: organizationId } })))
    throw new SpaceDeletionInProgressError();
}

/** The default Space of the user's oldest organization. */
export async function firstOrganizationSpace(prisma: PrismaClient, userId: string) {
  const space = await prisma.space.findFirst({
    where: {
      isDefault: true,
      deletingAt: null,
      organization: { members: { some: { userId, role: OWNER } } },
    },
    orderBy: [{ organization: { createdAt: "asc" } }, { organizationId: "asc" }],
    select: { id: true },
  });
  if (!space) throw new IsolationError();
  return space.id;
}
