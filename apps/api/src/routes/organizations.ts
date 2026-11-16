import { ORPCError } from "@orpc/server";
import { emailLocale, organizationInvitationEmail } from "@rakazo/auth";
import {
  acceptOrganizationInvitation,
  assertOrganizationMemberRemovable,
  cancelOrganizationInvitation,
  createOrganizationForUser,
  createOrganizationInvitation,
  deleteOrganizationMember,
  firstOrganizationSpace,
  InvalidSpaceNameError,
  leaveOrganizationSpaces,
  listMemberOrganizations,
  listOrganizationMembers,
  OrganizationMemberBusyError,
  previewOrganizationInvitation,
  recordAuditEvent,
  renameOrganization,
  runAsSystem,
  setOrganizationMemberRole,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { deleteOrganization } from "../account-deletion.js";
import type { RouterDeps } from "../router.js";
import { afterSpaceDeparture } from "../space-departure.js";
import type { RouterContext } from "./context.js";

/** Someone who joins again, or leaves, before their removal finished: at most this many passes. */
const REMOVAL_PASSES = 3;

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
            await assertOrganizationMemberRemovable(deps.prisma, ref);
            for (let pass = 0; ; pass += 1) {
              const departures = await leaveOrganizationSpaces(deps.prisma, {
                organizationId: input.organizationId,
                userId: input.userId,
                removedBy: context.actor.userId,
              });
              for (const departure of departures)
                await afterSpaceDeparture(
                  deps,
                  { spaceId: departure.spaceId, userId: context.actor.userId },
                  departure,
                );
              if (await deleteOrganizationMember(deps.prisma, ref)) break;
              if (pass + 1 >= REMOVAL_PASSES) throw new OrganizationMemberBusyError();
            }
            await recordAuditEvent({
              action: "organization.member.removed",
              actor: { type: "user", id: context.actor.userId },
              organizationId: input.organizationId,
              target: { type: "user", id: input.userId },
            });
            await bestEffort(
              "seat count after a removal",
              deps.billing?.syncSeats(input.organizationId),
            );
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
            });
            await recordAuditEvent({
              action: "organization.invitation.created",
              actor: { type: "user", id: context.actor.userId },
              organizationId: input.organizationId,
              target: { type: "invitation", id: invitation.id },
            });
            const url = invitationUrl(deps, invitation.id);
            const emailed = deps.email
              ? await sendInvitation(deps, deps.email, context.actor.userId, { ...invitation, url })
              : false;
            return { url, emailed };
          }),
        ),
        cancel: authed.organizations.invitations.cancel.handler(({ context, input }) =>
          runAsSystem("cancel an organization invitation", async () => {
            await cancelOrganizationInvitation(deps.prisma, {
              organizationId: input.organizationId,
              userId: context.actor.userId,
              invitationId: input.invitationId,
            });
            await recordAuditEvent({
              action: "organization.invitation.cancelled",
              actor: { type: "user", id: context.actor.userId },
              organizationId: input.organizationId,
              target: { type: "invitation", id: input.invitationId },
            });
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

/** Whether the email went out; when it did not, the inviter shares the link by hand. */
async function sendInvitation(
  deps: RouterDeps,
  email: NonNullable<RouterDeps["email"]>,
  inviterId: string,
  invitation: { email: string; organizationName: string; inviterName: string; url: string },
): Promise<boolean> {
  // The invitee's own language when they have an account here, else the inviter's.
  const [invitee, inviter] = await Promise.all([
    deps.prisma.user.findFirst({
      where: { email: { equals: invitation.email, mode: "insensitive" } },
      select: { locale: true },
    }),
    deps.prisma.user.findUnique({ where: { id: inviterId }, select: { locale: true } }),
  ]);
  const message = await organizationInvitationEmail(
    invitation.email,
    invitation,
    emailLocale(invitee?.locale ?? inviter?.locale),
  );
  return email.send(message).then(
    () => true,
    (error: unknown) => {
      deps.onEmailError?.(error);
      return false;
    },
  );
}
