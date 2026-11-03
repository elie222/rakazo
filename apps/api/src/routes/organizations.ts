import { ORPCError } from "@orpc/server";
import {
  CannotDeleteLastOrganizationError,
  createOrganizationForUser,
  firstOrganizationSpace,
  InvalidSpaceNameError,
  listOwnedOrganizations,
  OrganizationLimitError,
  recordAuditEvent,
  renameOrganization,
  runAsSystem,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import { deleteOrganization } from "../account-deletion.js";
import type { RouterContext } from "./context.js";

export function organizationsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    organizations: {
      list: authed.organizations.list.handler(({ context }) =>
        runAsSystem("list the organizations a user owns", () =>
          listOwnedOrganizations(deps.prisma, context.actor),
        ),
      ),
      create: authed.organizations.create.handler(({ context, input }) =>
        runAsSystem("create an organization for its owner", async () => {
          let organization: Awaited<ReturnType<typeof createOrganizationForUser>>;
          try {
            organization = await createOrganizationForUser(deps.prisma, {
              userId: context.actor.userId,
              name: input.name,
            });
          } catch (error) {
            if (error instanceof OrganizationLimitError || error instanceof InvalidSpaceNameError)
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            throw error;
          }
          await recordAuditEvent({
            action: "organization.created",
            actor: { type: "user", id: context.actor.userId },
            organizationId: organization.id,
            target: { type: "organization", id: organization.id, label: organization.name },
          });
          return organization;
        }),
      ),
      rename: authed.organizations.rename.handler(({ context, input }) =>
        runAsSystem("rename an organization for its owner", async () => {
          let renamed: { id: string; name: string };
          try {
            renamed = await renameOrganization(deps.prisma, {
              userId: context.actor.userId,
              organizationId: input.organizationId,
              name: input.name,
            });
          } catch (error) {
            if (error instanceof InvalidSpaceNameError)
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            throw error;
          }
          await recordAuditEvent({
            action: "organization.renamed",
            actor: { type: "user", id: context.actor.userId },
            organizationId: renamed.id,
            target: { type: "organization", id: renamed.id, label: renamed.name },
          });
          return renamed;
        }),
      ),
      // Audit events keep no foreign key to their organization, so this record outlives it.
      remove: authed.organizations.remove.handler(({ context, input }) =>
        runAsSystem("delete an organization with its content", async () => {
          const { userId } = context.actor;
          const organization = await deps.prisma.organization.findUnique({
            where: { id: input.organizationId },
            select: { name: true },
          });
          try {
            await deleteOrganization(deps, userId, input.organizationId);
          } catch (error) {
            if (error instanceof CannotDeleteLastOrganizationError)
              throw new ORPCError("BAD_REQUEST", { message: error.message });
            if (error instanceof SpaceDeletionInProgressError)
              throw new ORPCError("CONFLICT", { message: error.message });
            throw error;
          }
          await recordAuditEvent({
            action: "organization.deleted",
            actor: { type: "user", id: userId },
            organizationId: input.organizationId,
            target: {
              type: "organization",
              id: input.organizationId,
              label: organization?.name ?? null,
            },
          });
          return {
            ok: true as const,
            activeSpaceId: await firstOrganizationSpace(deps.prisma, userId),
          };
        }),
      ),
    },
  };
}
