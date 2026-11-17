import { ORPCError } from "@orpc/server";
import { organizationInvitationEmail } from "@rakazo/auth";
import {
  acceptOrganizationInvitation,
  cancelOrganizationInvitation,
  createOrganizationForUser,
  createOrganizationInvitation,
  firstOrganizationSpace,
  forgetRevokedMember,
  GUEST_ROLE,
  InvalidSpaceNameError,
  leaveOrganizationSpaces,
  listMemberOrganizations,
  listOrganizationMembers,
  previewOrganizationInvitation,
  recordAuditEvent,
  renameOrganization,
  revokeOrganizationMember,
  runAsSystem,
  setOrganizationMemberRole,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { deleteOrganization } from "../account/account-deletion.js";
import { invitationRecipientKey, sendInvitationEmail } from "../email/invitation-email.js";
import type { RouterDeps } from "../router.js";
import { afterSpaceDeparture } from "../spaces/space-departure.js";
import type { RouterContext } from "./context.js";

function invitationUrl(deps: RouterDeps, invitationId: string): string {
  return new URL(`/join/${invitationId}`, deps.env.webOrigin).toString();
}

export function organizationsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    organizations: {
      list: authed.organizations.list.handler(({ context }) =>
        runAsSystem("list the organizations a user belongs to", () =>
          listMemberOrganizations(deps.prisma, context.actor),
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
            if (error instanceof InvalidSpaceNameError) throw invalidOrganizationName();
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
            if (error instanceof InvalidSpaceNameError) throw invalidOrganizationName();
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
      members: {
        list: authed.organizations.members.list.handler(({ context, input }) =>
          runAsSystem("list an organization's members for one of them", async () => {
            const listed = await listOrganizationMembers(deps.prisma, {
              organizationId: input.organizationId,
              userId: context.actor.userId,
            });
            return {
              ...listed,
              invitations: listed.invitations.map((invitation) => ({
                id: invitation.id,
                email: invitation.email,
                url: invitationUrl(deps, invitation.id),
                expiresAt: invitation.expiresAt.toISOString(),
              })),
            };
          }),
        ),
        setRole: authed.organizations.members.setRole.handler(({ context, input }) =>
          runAsSystem("change an organization member's role", async () => {
            await setOrganizationMemberRole(deps.prisma, {
              organizationId: input.organizationId,
              userId: context.actor.userId,
              memberUserId: input.userId,
              role: input.role,
            });
            await recordAuditEvent({
              action: "organization.member.role_changed",
              actor: { type: "user", id: context.actor.userId },
              organizationId: input.organizationId,
              target: { type: "user", id: input.userId, label: input.role },
            });
            void deps.events?.publishOrganizationChange?.(input.organizationId);
            return { ok: true as const };
          }),
        ),
        remove: authed.organizations.members.remove.handler(({ context, input }) =>
          runAsSystem("remove someone from an organization", async () => {
            const ref = {
              organizationId: input.organizationId,
              userId: context.actor.userId,
              memberUserId: input.userId,
            };
            await revokeOrganizationMember(deps.prisma, ref);
            // The members changed once the revocation committed, so they hear it even if a later
            // step fails; the removed person's own list loses the organization too.
            try {
              // Their seat ends with their membership, before their Spaces change hands.
              await bestEffort(
                "seat count after a removal",
                deps.billing?.syncSeats(input.organizationId),
              );
              await leaveOrganizationSpaces(
                deps.prisma,
                {
                  organizationId: input.organizationId,
                  userId: input.userId,
                  removedBy: context.actor.userId,
                },
                async (departure) => {
                  await afterSpaceDeparture(
                    deps,
                    { spaceId: departure.spaceId, userId: context.actor.userId },
                    departure,
                  );
                  // Whoever took the Space over sees it change, as when they leave it.
                  void deps.events?.publishRosterChange?.({ spaceIds: [departure.spaceId] });
                },
              );
              await forgetRevokedMember(deps.prisma, ref);
              // Someone who accepted a new invitation meanwhile stays, and is not recorded as removed.
              const rejoined = await deps.prisma.member.findFirst({
                where: {
                  organizationId: input.organizationId,
                  userId: input.userId,
                  role: { not: GUEST_ROLE },
                },
                select: { id: true },
              });
              if (!rejoined)
                await recordAuditEvent({
                  action: "organization.member.removed",
                  actor: { type: "user", id: context.actor.userId },
                  organizationId: input.organizationId,
                  target: { type: "user", id: input.userId },
                });
            } finally {
              void deps.events?.publishOrganizationChange?.(input.organizationId, [input.userId]);
            }
            return { ok: true as const };
          }),
        ),
      },
      invitations: {
        create: authed.organizations.invitations.create.handler(({ context, input }) =>
          runAsSystem("invite someone to an organization", async () => {
            const invitation = await createOrganizationInvitation(deps.prisma, {
              organizationId: input.organizationId,
              userId: context.actor.userId,
              email: input.email,
              sendsEmail: Boolean(deps.email),
              recipientKey: invitationRecipientKey(deps),
            });
            // Past an address's daily limit the pending invitation comes back unchanged.
            if (invitation.created) {
              await recordAuditEvent({
                action: "organization.invitation.created",
                actor: { type: "user", id: context.actor.userId },
                organizationId: input.organizationId,
                target: { type: "invitation", id: invitation.id },
              });
              void deps.events?.publishOrganizationChange?.(input.organizationId);
            }
            const url = invitationUrl(deps, invitation.id);
            const emailed =
              invitation.send &&
              (await sendInvitationEmail(deps, context.actor.userId, invitation.email, (locale) =>
                organizationInvitationEmail(invitation.email, { ...invitation, url }, locale),
              ));
            return { url, emailed };
          }),
        ),
        cancel: authed.organizations.invitations.cancel.handler(({ context, input }) =>
          runAsSystem("cancel an organization invitation", async () => {
            const cancelled = await cancelOrganizationInvitation(deps.prisma, {
              organizationId: input.organizationId,
              userId: context.actor.userId,
              invitationId: input.invitationId,
            });
            // Only a pending invitation of this organization's is recorded as cancelled.
            if (cancelled) {
              await recordAuditEvent({
                action: "organization.invitation.cancelled",
                actor: { type: "user", id: context.actor.userId },
                organizationId: input.organizationId,
                target: { type: "invitation", id: input.invitationId },
              });
              void deps.events?.publishOrganizationChange?.(input.organizationId);
            }
            return { ok: true as const };
          }),
        ),
        // The invitee is not a member yet, so these look the organization up by the invitation.
        preview: authed.organizations.invitations.preview.handler(({ context, input }) =>
          runAsSystem("preview an invitation for its invitee", () =>
            previewOrganizationInvitation(deps.prisma, {
              invitationId: input.invitationId,
              userId: context.actor.userId,
              requireVerifiedEmail: Boolean(deps.email),
            }),
          ),
        ),
        accept: authed.organizations.invitations.accept.handler(({ context, input }) =>
          runAsSystem("join an organization by invitation", async () => {
            const joined = await acceptOrganizationInvitation(deps.prisma, {
              invitationId: input.invitationId,
              userId: context.actor.userId,
              requireVerifiedEmail: Boolean(deps.email),
            });
            await recordAuditEvent({
              action: "organization.member.joined",
              actor: { type: "user", id: context.actor.userId },
              organizationId: joined.organizationId,
              target: { type: "invitation", id: input.invitationId },
            });
            await bestEffort(
              "seat count after a join",
              deps.billing?.syncSeats(joined.organizationId),
            );
            void deps.events?.publishOrganizationChange?.(joined.organizationId);
            return { spaceId: joined.spaceId };
          }),
        ),
      },
      remove: authed.organizations.remove.handler(({ context, input }) =>
        runAsSystem("delete an organization with its content", async () => {
          const { userId } = context.actor;
          await deleteOrganization(deps, userId, input.organizationId);
          return {
            ok: true as const,
            activeSpaceId: await firstOrganizationSpace(deps.prisma, userId),
          };
        }),
      ),
    },
  };
}

function invalidOrganizationName() {
  return new ORPCError("BAD_REQUEST", {
    message: "Organization name must be readable and between 1 and 60 characters",
  });
}
