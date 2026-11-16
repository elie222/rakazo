import { randomUUID } from "node:crypto";
import type { OrganizationRole } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { GUEST_ROLE, isOwnerRole, LIVE_ORGANIZATION } from "./billing.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";
import { createOwnSpace, lockOrganizationSpaces, MAX_SPACES_PER_MEMBER } from "./spaces.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const ORGANIZATION_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Pending invitations per organization, so a mistaken or abusive batch of email stays small. */
export const MAX_PENDING_INVITATIONS = 50;
/** Invitation emails one address receives per day, from every organization together. */
export const MAX_INVITATION_EMAILS_PER_RECIPIENT_PER_DAY = 3;
/** Invitation emails one person sends per day across every organization they manage. */
export const MAX_INVITATION_EMAILS_PER_INVITER_PER_DAY = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Each invitation email, kept in the security log: no foreign keys, so deleting an organization
 * or an invitation never resets the counts. The address appears only as a keyed hash. */
const INVITATION_SENT = "organization.invitation.sent";
/** The Space each person gets when they join, theirs alone until they share it. */
const OWN_SPACE_NAME = "Personal";

const PENDING = "pending";

/** Inviting, changing roles and removing people: the owner and admins. */
export class OrganizationAdminRequiredError extends ClientError {
  constructor() {
    super("FORBIDDEN", "Only the organization's owner and admins can do that");
    this.name = "OrganizationAdminRequiredError";
  }
}

export class OrganizationMemberNotFoundError extends ClientError {
  constructor() {
    super("NOT_FOUND", "Member not found");
    this.name = "OrganizationMemberNotFoundError";
  }
}

/** One person sending more invitations in a day than anyone inviting colleagues would. */
export class OrganizationInvitationRateError extends ClientError {
  constructor() {
    super("TOO_MANY_REQUESTS", "Too many invitations today; try again tomorrow");
    this.name = "OrganizationInvitationRateError";
  }
}

export class OrganizationOwnerUnchangeableError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "The organization's owner cannot be removed or given another role");
    this.name = "OrganizationOwnerUnchangeableError";
  }
}

export class AlreadyOrganizationMemberError extends ClientError {
  constructor() {
    super("CONFLICT", "They are already a member", "ALREADY_MEMBER");
    this.name = "AlreadyOrganizationMemberError";
  }
}

export class OrganizationInvitationLimitError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "Too many pending invitations; cancel some or wait for them to expire");
    this.name = "OrganizationInvitationLimitError";
  }
}

/** One answer for unknown, expired, cancelled and used invitations, so none can be told apart. */
export class OrganizationInvitationNotFoundError extends ClientError {
  constructor() {
    super("NOT_FOUND", "This invitation is invalid or has expired");
    this.name = "OrganizationInvitationNotFoundError";
  }
}

/** Never names the address it went to: whoever holds the link may not own it. */
export class OrganizationInvitationEmailError extends ClientError {
  constructor(unverified = false) {
    super(
      "FORBIDDEN",
      unverified
        ? "Verify your email address to accept this invitation"
        : "Sign in with the email address this invitation was sent to",
      unverified ? "EMAIL_NOT_VERIFIED" : "INVITATION_EMAIL_MISMATCH",
    );
    this.name = "OrganizationInvitationEmailError";
  }
}

export class AccountBeingDeletedError extends ClientError {
  constructor() {
    super("CONFLICT", "Your account is being deleted");
    this.name = "AccountBeingDeletedError";
  }
}

/** Account deletion while others still depend on the organization the account owns. */
export class OwnedOrganizationHasMembersError extends ClientError {
  constructor() {
    super("CONFLICT", "Remove the other members of your organization before deleting your account");
    this.name = "OwnedOrganizationHasMembersError";
  }
}

/** The role shown and checked for a stored Better Auth role; guests are never listed. */
export function organizationRole(role: string): OrganizationRole {
  if (isOwnerRole(role)) return "owner";
  return role.split(",").some((value) => value.trim() === "admin") ? "admin" : "member";
}

/** Serializes one organization's membership changes, so each check holds until it commits. */
async function lockOrganizationMembers(tx: Prisma.TransactionClient, organizationId: string) {
  await lockKey(tx, `organization-members:${organizationId}`);
}

async function memberRole(
  db: Pick<PrismaClient, "member">,
  organizationId: string,
  userId: string,
): Promise<OrganizationRole | null> {
  const member = await db.member.findFirst({
    where: { organizationId, userId, role: { not: GUEST_ROLE }, organization: LIVE_ORGANIZATION },
    select: { role: true },
  });
  return member ? organizationRole(member.role) : null;
}

/** Throws `IsolationError` for a non-member, so the organization's existence stays private. */
async function requireManager(
  db: Pick<PrismaClient, "member">,
  organizationId: string,
  userId: string,
): Promise<OrganizationRole> {
  const role = await memberRole(db, organizationId, userId);
  if (!role) throw new IsolationError();
  if (role === "member") throw new OrganizationAdminRequiredError();
  return role;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function listOrganizationMembers(
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<{
  members: Array<{
    userId: string;
    name: string;
    email: string;
    image: string | null;
    role: OrganizationRole;
    manageable: boolean;
    roleChangeable: boolean;
  }>;
  invitations: Array<{ id: string; email: string; expiresAt: Date }>;
  canManage: boolean;
}> {
  const role = await memberRole(prisma, input.organizationId, input.userId);
  if (!role) throw new IsolationError();
  const canManage = role !== "member";
  const [rows, invitations] = await Promise.all([
    prisma.member.findMany({
      where: {
        organizationId: input.organizationId,
        // A guest never owns a Space, so one who does is a removal that stopped part way: they
        // stay listed until removing them again finishes it.
        OR: [
          { role: { not: GUEST_ROLE } },
          { spaceMemberships: { some: { role: { contains: "owner" } } } },
        ],
      },
      select: {
        userId: true,
        role: true,
        user: { select: { name: true, email: true, image: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    canManage
      ? prisma.invitation.findMany({
          where: {
            organizationId: input.organizationId,
            status: PENDING,
            expiresAt: { gt: new Date() },
          },
          select: { id: true, email: true, expiresAt: true },
          orderBy: { createdAt: "asc" },
        })
      : [],
  ]);
  const rank = { owner: 0, admin: 1, member: 2 } as const;
  const members = rows
    .map((row) => {
      const memberRole = organizationRole(row.role);
      const manageable = canManage && memberRole !== "owner" && row.userId !== input.userId;
      return {
        userId: row.userId,
        ...row.user,
        role: memberRole,
        manageable,
        // A guest listed here is a removal that stopped part way: removing again finishes it.
        roleChangeable: manageable && row.role !== GUEST_ROLE,
      };
    })
    .sort((a, b) => rank[a.role] - rank[b.role]);
  return { members, invitations, canManage };
}

/** Holds a transaction-scoped lock on `key` until the transaction ends. */
async function lockKey(tx: Prisma.TransactionClient, key: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "lock"
  `);
}

/**
 * Whether one more invitation email may go to an address now, from an organization or a Space:
 * the daily limits count every one. Only someone whose own address is proven sends mail in the
 * server's name (`mayEmail`); anyone else shares the link by hand. Past the address's limit
 * nothing is emailed, and past the inviter's the invitation is refused. Takes the inviter's and
 * the address's locks, so two invitations at once cannot both take the last email allowed.
 */
export async function invitationEmailAllowance(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    /** The address as a hash keyed with a server secret, as the security log names it. */
    recipient: string;
    sendsEmail: boolean;
  },
): Promise<{ mayEmail: boolean; send: boolean }> {
  await lockKey(tx, `invitation-sender:${input.userId}`);
  await lockKey(tx, `invitation-recipient:${input.recipient}`);
  const today = { gt: new Date(Date.now() - DAY_MS) };
  const [inviter, toRecipient, byInviter] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { emailVerified: true } }),
    tx.securityEvent.count({
      where: {
        type: INVITATION_SENT,
        createdAt: today,
        metadata: { path: ["recipient"], equals: input.recipient },
      },
    }),
    tx.securityEvent.count({
      where: { type: INVITATION_SENT, userId: input.userId, createdAt: today },
    }),
  ]);
  const mayEmail = input.sendsEmail && inviter.emailVerified;
  const send = mayEmail && toRecipient < MAX_INVITATION_EMAILS_PER_RECIPIENT_PER_DAY;
  if (send && byInviter >= MAX_INVITATION_EMAILS_PER_INVITER_PER_DAY)
    throw new OrganizationInvitationRateError();
  return { mayEmail, send };
}

/** Each invitation email allowed, recorded in the transaction that allows it. */
export async function recordInvitationEmail(
  tx: Prisma.TransactionClient,
  input: { userId: string; metadata: { recipient: string } & Record<string, string> },
): Promise<void> {
  await tx.securityEvent.create({
    data: { type: INVITATION_SENT, userId: input.userId, metadata: input.metadata },
  });
}

/**
 * Owner and admins. Inviting the same address again replaces its pending invitation with a new
 * one, which is how a lost email is resent. With `sendsEmail`, each email is recorded as it is
 * allowed, in the same transaction, and the daily limits count those records: resending,
 * cancelling or deleting the organization never resets them. Past an address's limit nothing is
 * emailed: its pending invitation, or a new one, is returned unsent for its link to be shared by
 * hand.
 */
export async function createOrganizationInvitation(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    userId: string;
    email: string;
    sendsEmail: boolean;
    /** Names the address in the security log: a hash keyed with a server secret. */
    recipientKey: (email: string) => string;
  },
): Promise<{
  id: string;
  email: string;
  organizationName: string;
  inviterName: string;
  /** False past the address's limit, when the pending invitation comes back unchanged. */
  created: boolean;
  /** Whether to email it now; false past the address's limit or without email delivery. */
  send: boolean;
}> {
  const email = normalizeEmail(input.email);
  const recipient = input.recipientKey(email);
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockOrganizationMembers(tx, input.organizationId);
      await requireManager(tx, input.organizationId, input.userId);
      const existing = await tx.member.findFirst({
        where: {
          organizationId: input.organizationId,
          role: { not: GUEST_ROLE },
          user: { email: { equals: email, mode: "insensitive" } },
        },
        select: { id: true },
      });
      if (existing) throw new AlreadyOrganizationMemberError();
      const { mayEmail, send } = await invitationEmailAllowance(tx, {
        userId: input.userId,
        recipient,
        sendsEmail: input.sendsEmail,
      });
      const now = new Date();
      const [organization, inviter, pending, open] = await Promise.all([
        tx.organization.findUniqueOrThrow({
          where: { id: input.organizationId },
          select: { name: true },
        }),
        tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { name: true } }),
        tx.invitation.findFirst({
          where: {
            organizationId: input.organizationId,
            email,
            status: PENDING,
            expiresAt: { gt: now },
          },
          select: { id: true },
        }),
        tx.invitation.count({
          where: { organizationId: input.organizationId, status: PENDING, expiresAt: { gt: now } },
        }),
      ]);
      const names = { organizationName: organization.name, inviterName: inviter.name };
      // Past the address's limit nothing is emailed, but the inviter still gets a link to share:
      // the pending one, or a new one when another invitation used the limit up.
      if (mayEmail && !send && pending)
        return { id: pending.id, email, ...names, created: false, send: false };
      if (!pending && open >= MAX_PENDING_INVITATIONS) throw new OrganizationInvitationLimitError();
      // Its link stops working: the new invitation carries the new one.
      await tx.invitation.updateMany({
        where: { organizationId: input.organizationId, email, status: PENDING },
        data: { status: "canceled" },
      });
      const id = randomUUID();
      await tx.invitation.create({
        data: {
          id,
          organizationId: input.organizationId,
          email,
          role: "member",
          status: PENDING,
          expiresAt: new Date(now.getTime() + ORGANIZATION_INVITATION_TTL_MS),
          createdAt: now,
          inviterId: input.userId,
        },
      });
      if (send)
        await recordInvitationEmail(tx, {
          userId: input.userId,
          metadata: { organizationId: input.organizationId, recipient },
        });
      return { id, email, ...names, created: true, send };
    }),
  );
}

export async function cancelOrganizationInvitation(
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; invitationId: string },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockOrganizationMembers(tx, input.organizationId);
    await requireManager(tx, input.organizationId, input.userId);
    const { count } = await tx.invitation.updateMany({
      where: { id: input.invitationId, organizationId: input.organizationId, status: PENDING },
      data: { status: "canceled" },
    });
    return count > 0;
  });
}

type InvitationRow = {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
  organization: { name: string };
  user: { name: string };
};

type InviteeInput = {
  invitationId: string;
  userId: string;
  /**
   * Whether the account must have proved it receives the address's mail. Set when the server
   * sends email, so every account could have; without email delivery nobody is verified, and the
   * unguessable link sent to that address stands in for the proof.
   */
  requireVerifiedEmail: boolean;
};

/** A pending, unexpired invitation to a live organization, for the signed-in invitee only. */
async function findInvitation(
  db: Pick<PrismaClient, "invitation" | "user">,
  input: InviteeInput,
): Promise<InvitationRow> {
  const invitation = await db.invitation.findFirst({
    where: {
      id: input.invitationId,
      status: PENDING,
      expiresAt: { gt: new Date() },
      organization: LIVE_ORGANIZATION,
    },
    select: {
      id: true,
      organizationId: true,
      email: true,
      role: true,
      organization: { select: { name: true } },
      user: { select: { name: true } },
    },
  });
  if (!invitation) throw new OrganizationInvitationNotFoundError();
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { email: true, emailVerified: true },
  });
  if (!user || normalizeEmail(user.email) !== invitation.email)
    throw new OrganizationInvitationEmailError();
  if (input.requireVerifiedEmail && !user.emailVerified)
    throw new OrganizationInvitationEmailError(true);
  return invitation;
}

export async function previewOrganizationInvitation(
  prisma: PrismaClient,
  input: InviteeInput,
): Promise<{ organizationName: string; inviterName: string }> {
  const invitation = await findInvitation(prisma, input);
  return { organizationName: invitation.organization.name, inviterName: invitation.user.name };
}

/**
 * Joins the organization an invitation is for. Claiming the invitation and adding the member
 * commit together, so it is used at most once. The new member sees none of anyone else's Spaces:
 * they get one of their own to land in, and others add them to theirs.
 */
export async function acceptOrganizationInvitation(
  prisma: PrismaClient,
  input: InviteeInput,
): Promise<{ organizationId: string; spaceId: string }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const invitation = await findInvitation(tx, input);
        const { organizationId } = invitation;
        await lockOrganizationMembers(tx, organizationId);
        // A Space created here waits for, or is refused by, a deletion of the organization.
        await lockOrganizationSpaces(tx, organizationId);
        // Row-locked, after the locks above as deletions take them. An owner's account deletion
        // claims this Space before checking who else belongs, so its claim either waits for this
        // join and then sees it, or this join sees the claim and is refused.
        const [live] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "spaces"
          WHERE "organizationId" = ${organizationId} AND "isDefault" AND "deletingAt" IS NULL
          FOR SHARE
        `;
        if (!live) throw new OrganizationInvitationNotFoundError();
        // An account being deleted joins nothing: its Spaces were already chosen for deletion, so a
        // new one would outlive it with no members.
        const [deleting] = await tx.$queryRaw<Array<{ key: string }>>`
          SELECT key FROM "leases"
          WHERE key = ${`account-deletion:${input.userId}`} AND "expiresAt" > now()
          FOR SHARE
        `;
        if (deleting) throw new AccountBeingDeletedError();
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, status: PENDING, expiresAt: { gt: new Date() } },
          data: { status: "accepted" },
        });
        if (claimed.count !== 1) throw new OrganizationInvitationNotFoundError();
        const role = organizationRole(invitation.role ?? "member");
        const existing = await tx.member.findUnique({
          where: { organizationId_userId: { organizationId, userId: input.userId } },
          select: { id: true, role: true },
        });
        if (existing && existing.role !== GUEST_ROLE) throw new AlreadyOrganizationMemberError();
        if (existing) {
          // A guest in some of its Spaces becomes a full member, keeping those Spaces.
          await tx.member.update({ where: { id: existing.id }, data: { role } });
        } else {
          const memberId = randomUUID();
          await tx.member.create({
            data: {
              id: memberId,
              organizationId,
              userId: input.userId,
              role,
              createdAt: new Date(),
            },
          });
          // A database trigger adds every new member to the default Space, which is the owner's
          // own; a new member starts with none of anyone else's Spaces.
          await tx.spaceMember.deleteMany({
            where: { id: `default-space-member:${memberId}`, userId: input.userId },
          });
        }
        // A guest already in as many of its Spaces as anyone may be lands in the first of them.
        const spaces = await tx.spaceMember.findMany({
          where: { organizationId, userId: input.userId },
          select: { spaceId: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        const spaceId =
          spaces.length >= MAX_SPACES_PER_MEMBER
            ? spaces[0]!.spaceId
            : await createOwnSpace(tx, {
                organizationId,
                userId: input.userId,
                name: OWN_SPACE_NAME,
              });
        return { organizationId, spaceId };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Owner and admins, between admin and member. The owner's role never changes. */
export async function setOrganizationMemberRole(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    userId: string;
    memberUserId: string;
    role: Exclude<OrganizationRole, "owner">;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockOrganizationMembers(tx, input.organizationId);
    await requireManager(tx, input.organizationId, input.userId);
    const target = await memberRole(tx, input.organizationId, input.memberUserId);
    if (!target) throw new OrganizationMemberNotFoundError();
    if (target === "owner") throw new OrganizationOwnerUnchangeableError();
    await tx.member.update({
      where: {
        organizationId_userId: { organizationId: input.organizationId, userId: input.memberUserId },
      },
      data: { role: input.role },
    });
    // Someone who can no longer invite leaves no invitation of theirs open.
    if (input.role === "member") await cancelInvitationsBy(tx, input);
  });
}

/** Withdraws the pending invitations someone sent to an organization, once they cannot invite. */
async function cancelInvitationsBy(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; memberUserId: string },
) {
  await tx.invitation.updateMany({
    where: { organizationId: input.organizationId, inviterId: input.memberUserId, status: PENDING },
    data: { status: "canceled" },
  });
}

/**
 * The first step of a removal, before any of the person's Spaces change hands: they become a
 * guest at once, so from here they can no longer create Spaces in the organization, be added to
 * its Spaces, or spend its credits, and leaving each Space then finishes the removal. A removal
 * that stopped part way is finished by asking again, which finds them a guest already.
 */
export async function revokeOrganizationMember(
  prisma: PrismaClient,
  input: { organizationId: string; userId: string; memberUserId: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockOrganizationMembers(tx, input.organizationId);
    await requireManager(tx, input.organizationId, input.userId);
    if (input.memberUserId === input.userId) throw new OrganizationAdminRequiredError();
    const target = await tx.member.findUnique({
      where: {
        organizationId_userId: { organizationId: input.organizationId, userId: input.memberUserId },
      },
      select: { role: true },
    });
    if (!target) throw new OrganizationMemberNotFoundError();
    if (isOwnerRole(target.role)) throw new OrganizationOwnerUnchangeableError();
    if (target.role !== GUEST_ROLE)
      await tx.member.update({
        where: {
          organizationId_userId: {
            organizationId: input.organizationId,
            userId: input.memberUserId,
          },
        },
        data: { role: GUEST_ROLE },
      });
    await cancelInvitationsBy(tx, input);
    // Nor can an invitation sent to them before bring them back.
    const removed = await tx.user.findUnique({
      where: { id: input.memberUserId },
      select: { email: true },
    });
    if (removed)
      await tx.invitation.updateMany({
        where: {
          organizationId: input.organizationId,
          email: normalizeEmail(removed.email),
          status: PENDING,
        },
        data: { status: "canceled" },
      });
  });
}

/** The last step: a removed person who belongs to no Space there any more is no longer listed. */
export async function forgetRevokedMember(
  prisma: Pick<PrismaClient, "member">,
  input: { organizationId: string; memberUserId: string },
): Promise<void> {
  await prisma.member.deleteMany({
    where: {
      organizationId: input.organizationId,
      userId: input.memberUserId,
      role: GUEST_ROLE,
      spaceMemberships: { none: {} },
    },
  });
}

/** Organizations the user belongs to as a full member without owning them. */
export async function joinedOrganizationIds(
  prisma: Pick<PrismaClient, "member">,
  userId: string,
): Promise<string[]> {
  const memberships = await prisma.member.findMany({
    where: { userId, role: { not: GUEST_ROLE } },
    select: { organizationId: true, role: true },
  });
  return memberships
    .filter((membership) => !isOwnerRole(membership.role))
    .map((membership) => membership.organizationId);
}

/**
 * Refuses deleting the account of an organization's only owner while other people still belong
 * to it, since nobody would be left to manage it.
 */
export async function assertNoOwnedOrganizationWithMembers(
  prisma: Pick<PrismaClient, "member">,
  userId: string,
): Promise<void> {
  const owned = await prisma.member.findMany({
    where: { userId, role: { contains: "owner" } },
    select: {
      organization: {
        select: {
          members: {
            where: { userId: { not: userId }, role: { not: GUEST_ROLE } },
            select: { role: true },
          },
        },
      },
    },
  });
  const ownerless = owned.some(
    ({ organization }) =>
      organization.members.length > 0 &&
      !organization.members.some((member) => isOwnerRole(member.role)),
  );
  if (ownerless) throw new OwnedOrganizationHasMembersError();
}
