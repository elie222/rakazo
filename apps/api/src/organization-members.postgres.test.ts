import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  acceptOrganizationInvitation,
  asSystem,
  assertNoOwnedOrganizationWithMembers,
  createDb,
  createThreadEvents,
  installAuditEventStore,
  leaveOrganizationSpaces,
  OrganizationAdminRequiredError,
  OwnedOrganizationHasMembersError,
  publishOrganizationChange,
  revokeOrganizationMember,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const webOrigin = "https://app.example.test";

describePostgres("organization members and invitations (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const syncSeats = vi.fn(async (_organizationId: string) => undefined);
  const publishRosterChange = vi.fn(async (_change: unknown) => undefined);
  /** The topics organization signals went to, as the fanout received them. */
  const organizationSignals: string[] = [];
  const fanout = {
    publish: async (topic: string) => {
      organizationSignals.push(topic);
    },
  };
  const sent: TransactionalEmail[] = [];
  const email = {
    send: vi.fn(async (message: TransactionalEmail) => {
      sent.push(message);
    }),
    describe: () => ({ id: "test" }),
  };
  const users: string[] = [];
  const organizations: string[] = [];

  type Person = { id: string; email: string; organizationId: string; actor: Actor };

  async function person(name: string, { verified = true } = {}): Promise<Person> {
    const id = `org-${name.replaceAll(" ", "-").toLowerCase()}-${randomUUID()}`;
    const address = `${id}@example.test`;
    users.push(id);
    organizations.push(id);
    const createdAt = new Date();
    await system.user.create({ data: { id, name, email: address, emailVerified: verified } });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    await system.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true, createdByUserId: id },
    });
    await system.spaceMember.create({
      data: {
        id: `sm-${id}`,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt,
      },
    });
    return {
      id,
      email: address,
      organizationId: id,
      actor: { userId: id, spaceId: id, email: address, isDeploymentOwner: false },
    };
  }

  async function call(actor: Actor, path: string, input: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: Record<string, unknown> };
    return { status: response!.status, json: body.json };
  }

  async function invite(inviter: Person, organizationId: string, address: string) {
    const created = await call(inviter.actor, "organizations/invitations/create", {
      organizationId,
      email: address,
    });
    expect(created.status).toBe(200);
    return new URL(created.json.url as string).pathname.split("/").at(-1)!;
  }

  /** Invites and accepts, returning the new member's actor in their own new Space. */
  async function join(inviter: Person, invitee: Person): Promise<Actor> {
    const invitationId = await invite(inviter, inviter.organizationId, invitee.email);
    const accepted = await call(invitee.actor, "organizations/invitations/accept", {
      invitationId,
    });
    expect(accepted.status).toBe(200);
    return { ...invitee.actor, spaceId: accepted.json.spaceId as string };
  }

  async function sharedSpace(owner: Person, name: string): Promise<string> {
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: owner.organizationId, name, createdByUserId: owner.id },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId: owner.organizationId,
        userId: owner.id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    return spaceId;
  }

  function role(organizationId: string, userId: string) {
    return system.member.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true },
    });
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installAuditEventStore(prisma);
    const deps = {
      prisma,
      billing: { syncSeats },
      email,
      jobs: { cancel: vi.fn(async () => undefined), enqueue: vi.fn(async () => undefined) },
      events: {
        ...createThreadEvents(prisma),
        notify: vi.fn(async () => undefined),
        publishRosterChange,
        publishOrganizationChange: (organizationId: string, alsoUserIds?: readonly string[]) =>
          publishOrganizationChange(prisma, fanout as never, organizationId, alsoUserIds),
      },
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin,
        screenProxySecret: "fake-test-secret",
        invitationRecipientKey: "fake-recipient-key",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-organization-members-test",
    } as unknown as RouterDeps;
    handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: { in: organizations } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("emails an invitation the invited address alone can accept, once", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const stranger = await person("stranger");
    const organizationId = owner.organizationId;

    const created = await call(owner.actor, "organizations/invitations/create", {
      organizationId,
      email: invitee.email.toUpperCase(),
    });
    expect(created.status).toBe(200);
    expect(created.json.emailed).toBe(true);
    const url = new URL(created.json.url as string);
    expect(url.origin).toBe(webOrigin);
    expect(url.pathname).toMatch(/^\/join\/[0-9a-f-]{36}$/);
    const invitationId = url.pathname.split("/").at(-1)!;
    expect(sent.at(-1)?.to).toBe(invitee.email);
    expect(sent.at(-1)?.text).toContain(url.toString());
    await expect(
      system.invitation.findUniqueOrThrow({ where: { id: invitationId } }),
    ).resolves.toMatchObject({ email: invitee.email, status: "pending", role: "member" });

    // Inviting the same address again sends a new link and retires the old one.
    const sentBefore = sent.length;
    const again = await call(owner.actor, "organizations/invitations/create", {
      organizationId,
      email: invitee.email,
    });
    expect(again.json).toMatchObject({ emailed: true });
    expect(again.json.url).not.toBe(created.json.url);
    expect(
      (await call(invitee.actor, "organizations/invitations/preview", { invitationId })).status,
    ).toBe(404);
    // A third email is the day's last; after that the link comes back unsent.
    const third = await call(owner.actor, "organizations/invitations/create", {
      organizationId,
      email: invitee.email,
    });
    const capped = await call(owner.actor, "organizations/invitations/create", {
      organizationId,
      email: invitee.email,
    });
    expect(capped.json).toEqual({ url: third.json.url, emailed: false });
    expect(sent.length).toBe(sentBefore + 2);
    // Each email is on record, and only a keyed hash names the address.
    const records = await system.securityEvent.findMany({
      where: { type: "organization.invitation.sent", userId: owner.id },
      select: { metadata: true },
    });
    expect(records).toHaveLength(3);
    expect(JSON.stringify(records)).not.toContain(invitee.email);
    const latest = new URL(third.json.url as string).pathname.split("/").at(-1)!;
    // Cancelling does not reset the count either, and another organization's invitations count
    // too; past the limit the inviter still gets a link to share, unsent.
    const other = `other-${invitee.email}`;
    for (let count = 0; count < 3; count += 1) await invite(owner, organizationId, other);
    const pendingOther = await system.invitation.findFirstOrThrow({
      where: { organizationId, email: other, status: "pending" },
    });
    await call(owner.actor, "organizations/invitations/cancel", {
      organizationId,
      invitationId: pendingOther.id,
    });
    const elsewhere = await person("elsewhere");
    for (const inviter of [owner, elsewhere]) {
      const unsent = await call(inviter.actor, "organizations/invitations/create", {
        organizationId: inviter.organizationId,
        email: other,
      });
      expect(unsent.status).toBe(200);
      expect(unsent.json.emailed).toBe(false);
    }
    expect(sent.filter((message) => message.to === other)).toHaveLength(3);

    // Someone else holding the link learns nothing and cannot join.
    for (const path of ["preview", "accept"]) {
      const refused = await call(stranger.actor, `organizations/invitations/${path}`, {
        invitationId: latest,
      });
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.json)).not.toContain(invitee.email);
    }

    const preview = await call(invitee.actor, "organizations/invitations/preview", {
      invitationId: latest,
    });
    expect(preview.json).toEqual({ organizationName: "Personal", inviterName: "owner" });

    const accepted = await call(invitee.actor, "organizations/invitations/accept", {
      invitationId: latest,
    });
    expect(accepted.status).toBe(200);
    const ownSpaceId = accepted.json.spaceId as string;
    expect(syncSeats).toHaveBeenCalledWith(organizationId);
    await expect(role(organizationId, invitee.id)).resolves.toEqual({ role: "member" });
    // They see none of the owner's Spaces, only one of their own.
    const memberships = await system.spaceMember.findMany({
      where: { organizationId, userId: invitee.id },
      select: { spaceId: true, role: true, space: { select: { isDefault: true } } },
    });
    expect(memberships).toEqual([
      { spaceId: ownSpaceId, role: "owner", space: { isDefault: false } },
    ]);

    expect(
      (await call(invitee.actor, "organizations/invitations/accept", { invitationId: latest }))
        .status,
    ).toBe(404);
    const list = await call(invitee.actor, "organizations/list", {});
    expect(list.json.organizations).toContainEqual(
      expect.objectContaining({
        id: organizationId,
        defaultSpaceId: ownSpaceId,
        spaceIds: [ownSpaceId],
        role: "member",
        canManage: false,
        memberCount: 2,
      }),
    );
    const actions = await system.auditEvent.findMany({
      where: { organizationId },
      select: { action: true },
    });
    expect(actions.map((event) => event.action)).toEqual(
      expect.arrayContaining(["organization.invitation.created", "organization.member.joined"]),
    );
  });

  it("refuses expired, cancelled and unverified acceptances", async () => {
    const owner = await person("owner");
    const late = await person("late");
    const cancelled = await person("cancelled");
    const unverified = await person("unverified", { verified: false });

    const expired = await invite(owner, owner.organizationId, late.email);
    await system.invitation.update({
      where: { id: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await call(late.actor, "organizations/invitations/accept", { invitationId: expired }))
        .status,
    ).toBe(404);

    const withdrawn = await invite(owner, owner.organizationId, cancelled.email);
    expect(
      (
        await call(owner.actor, "organizations/invitations/cancel", {
          organizationId: owner.organizationId,
          invitationId: withdrawn,
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(cancelled.actor, "organizations/invitations/accept", { invitationId: withdrawn }))
        .status,
    ).toBe(404);

    const unproven = await invite(owner, owner.organizationId, unverified.email);
    expect(
      (await call(unverified.actor, "organizations/invitations/accept", { invitationId: unproven }))
        .status,
    ).toBe(403);
    await expect(role(owner.organizationId, unverified.id)).resolves.toBeNull();
    // An unverified account sends no invitation email; its link is shared by hand.
    const sentBefore = sent.length;
    const unsentInvite = await call(unverified.actor, "organizations/invitations/create", {
      organizationId: unverified.organizationId,
      email: cancelled.email,
    });
    expect(unsentInvite.status).toBe(200);
    expect(unsentInvite.json.emailed).toBe(false);
    expect(sent.length).toBe(sentBefore);

    // A server that sends no email verifies nobody, so the link sent to the address is the proof.
    await expect(
      acceptOrganizationInvitation(system, {
        invitationId: unproven,
        userId: unverified.id,
        requireVerifiedEmail: false,
      }),
    ).resolves.toMatchObject({ organizationId: owner.organizationId });
    await expect(role(owner.organizationId, unverified.id)).resolves.toEqual({ role: "member" });

    // Nor does an account while it is being deleted.
    const leaving = await person("leaving");
    const leavingJoin = await invite(owner, owner.organizationId, leaving.email);
    await system.lease.create({
      data: {
        key: `account-deletion:${leaving.id}`,
        fence: 1n,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(
      (await call(leaving.actor, "organizations/invitations/accept", { invitationId: leavingJoin }))
        .status,
    ).toBe(409);
    await expect(role(owner.organizationId, leaving.id)).resolves.toBeNull();
    await system.lease.delete({ where: { key: `account-deletion:${leaving.id}` } });

    // Once the owner's account deletion claims the organization, nobody joins it.
    const joiner = await person("joiner");
    const claimedJoin = await invite(owner, owner.organizationId, joiner.email);
    await system.space.update({ where: { id: owner.id }, data: { deletingAt: new Date() } });
    expect(
      (await call(joiner.actor, "organizations/invitations/accept", { invitationId: claimedJoin }))
        .status,
    ).toBe(404);
    await expect(role(owner.organizationId, joiner.id)).resolves.toBeNull();
  });

  it("lets only the owner and admins manage members, and never the owner", async () => {
    const owner = await person("owner");
    const admin = await person("admin");
    const member = await person("member");
    const outsider = await person("outsider");
    const organizationId = owner.organizationId;
    const adminActor = await join(owner, admin);
    const memberActor = await join(owner, member);

    // A member sees the list but cannot change it or see invitations.
    const seen = await call(memberActor, "organizations/members/list", { organizationId });
    expect(seen.json).toMatchObject({ canManage: false, invitations: [] });
    expect((seen.json.members as Array<{ role: string }>).map((each) => each.role)).toEqual([
      "owner",
      "member",
      "member",
    ]);
    expect(
      (
        await call(memberActor, "organizations/invitations/create", {
          organizationId,
          email: outsider.email,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(memberActor, "organizations/members/setRole", {
          organizationId,
          userId: admin.id,
          role: "admin",
        })
      ).status,
    ).toBe(403);
    // Someone outside it is told it does not exist.
    expect(
      (await call(outsider.actor, "organizations/members/list", { organizationId })).status,
    ).toBe(404);

    expect(
      (
        await call(owner.actor, "organizations/members/setRole", {
          organizationId,
          userId: admin.id,
          role: "admin",
        })
      ).status,
    ).toBe(200);
    await expect(role(organizationId, admin.id)).resolves.toEqual({ role: "admin" });

    // Nobody makes another owner, demotes or removes the owner.
    expect(
      (
        await call(owner.actor, "organizations/members/setRole", {
          organizationId,
          userId: admin.id,
          role: "owner",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(adminActor, "organizations/members/setRole", {
          organizationId,
          userId: owner.id,
          role: "member",
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(adminActor, "organizations/members/remove", { organizationId, userId: owner.id }))
        .status,
    ).toBe(400);
    await expect(role(organizationId, owner.id)).resolves.toEqual({ role: "owner" });

    // An admin invites; an existing member cannot be invited again.
    expect(
      (
        await call(adminActor, "organizations/invitations/create", {
          organizationId,
          email: outsider.email,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(adminActor, "organizations/invitations/create", {
          organizationId,
          email: member.email,
        })
      ).status,
    ).toBe(409);
    const managed = await call(adminActor, "organizations/members/list", { organizationId });
    expect(managed.json).toMatchObject({
      canManage: true,
      invitations: [{ email: outsider.email }],
    });

    // Once the admin can no longer invite, what they sent stops working.
    expect(
      (
        await call(owner.actor, "organizations/members/setRole", {
          organizationId,
          userId: admin.id,
          role: "member",
        })
      ).status,
    ).toBe(200);
    await expect(
      system.invitation.count({
        where: { organizationId, inviterId: admin.id, status: "pending" },
      }),
    ).resolves.toBe(0);

    // The owner of an organization others belong to cannot delete their account yet.
    await expect(assertNoOwnedOrganizationWithMembers(system, owner.id)).rejects.toBeInstanceOf(
      OwnedOrganizationHasMembersError,
    );
    await expect(assertNoOwnedOrganizationWithMembers(system, member.id)).resolves.toBeUndefined();
  });

  it("adds members to a Space from the organization and hands a removed member's Spaces on", async () => {
    const owner = await person("owner");
    const member = await person("Alex Member");
    const outsider = await person("outsider");
    const organizationId = owner.organizationId;
    const memberActor = await join(owner, member);
    const ownSpaceId = memberActor.spaceId;
    const team = await sharedSpace(owner, "Team");
    const ownerInTeam = { ...owner.actor, spaceId: team };

    const before = await call(ownerInTeam, "spaces/members/list", { spaceId: team });
    expect(before.json.addable).toEqual([
      { userId: member.id, name: "Alex Member", email: member.email, image: null },
    ]);
    // Only people in the organization, and only by the Space's owner.
    expect(
      (await call(ownerInTeam, "spaces/members/add", { spaceId: team, userId: outsider.id }))
        .status,
    ).toBe(404);
    expect(
      (await call(memberActor, "spaces/members/add", { spaceId: team, userId: member.id })).status,
    ).toBe(404);
    expect(
      (await call(ownerInTeam, "spaces/members/add", { spaceId: team, userId: member.id })).status,
    ).toBe(200);
    await expect(
      system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: team, userId: member.id } },
      }),
    ).resolves.toMatchObject({ role: "member" });

    const bot = await system.bot.create({
      data: { spaceId: ownSpaceId, userId: member.id, name: "Notes", color: "test" },
    });

    expect(
      (
        await call(owner.actor, "organizations/members/remove", {
          organizationId,
          userId: member.id,
        })
      ).status,
    ).toBe(200);
    await expect(role(organizationId, member.id)).resolves.toBeNull();
    await expect(
      system.spaceMember.count({ where: { organizationId, userId: member.id } }),
    ).resolves.toBe(0);
    // Their own Space stays with the organization, named after them, for whoever removed them.
    await expect(
      system.space.findUniqueOrThrow({ where: { id: ownSpaceId }, select: { name: true } }),
    ).resolves.toEqual({ name: "Alex Member" });
    await expect(
      system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: ownSpaceId, userId: owner.id } },
      }),
    ).resolves.toMatchObject({ role: "owner" });
    await expect(
      system.bot.findUniqueOrThrow({ where: { id: bot.id }, select: { userId: true } }),
    ).resolves.toEqual({ userId: owner.id });
    expect(syncSeats).toHaveBeenCalledWith(organizationId);
    // Whoever took over one of their Spaces is told, like everyone left in each.
    for (const spaceId of [ownSpaceId, team])
      expect(publishRosterChange).toHaveBeenCalledWith({ spaceIds: [spaceId] });
    expect((await call(memberActor, "organizations/members/list", { organizationId })).status).toBe(
      404,
    );
  });

  it("hands no Space to a remover who has stopped managing the organization", async () => {
    const owner = await person("owner");
    const admin = await person("admin");
    const member = await person("member");
    const organizationId = owner.organizationId;
    await join(owner, admin);
    await system.member.update({
      where: { organizationId_userId: { organizationId, userId: admin.id } },
      data: { role: "admin" },
    });
    const { spaceId: ownSpaceId } = await join(owner, member);

    await revokeOrganizationMember(system, {
      organizationId,
      userId: admin.id,
      memberUserId: member.id,
    });
    // Demoted before their Spaces change hands.
    await system.member.update({
      where: { organizationId_userId: { organizationId, userId: admin.id } },
      data: { role: "member" },
    });
    await expect(
      leaveOrganizationSpaces(
        prisma,
        { organizationId, userId: member.id, removedBy: admin.id },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(OrganizationAdminRequiredError);
    await expect(
      system.spaceMember.findMany({ where: { spaceId: ownSpaceId }, select: { userId: true } }),
    ).resolves.toEqual([{ userId: member.id }]);
    // Still listed, so the removal can be finished.
    const listed = await call(owner.actor, "organizations/members/list", { organizationId });
    expect(listed.json.members).toContainEqual(
      expect.objectContaining({ userId: member.id, manageable: true, roleChangeable: false }),
    );

    // The owner finishes the removal and keeps the Space.
    expect(
      (
        await call(owner.actor, "organizations/members/remove", {
          organizationId,
          userId: member.id,
        })
      ).status,
    ).toBe(200);
    await expect(
      system.spaceMember.findMany({
        where: { spaceId: ownSpaceId },
        select: { userId: true, role: true },
      }),
    ).resolves.toEqual([{ userId: owner.id, role: "owner" }]);
  });

  it("revokes a member before their Spaces change hands, so they cannot outrun the removal", async () => {
    const owner = await person("owner");
    const member = await person("member");
    const organizationId = owner.organizationId;
    const memberActor = await join(owner, member);

    // A link they made to their own Space before the removal.
    const saved = await call(memberActor, "spaces/invites/create", {
      spaceId: memberActor.spaceId,
    });
    expect(saved.status).toBe(200);
    const savedToken = new URL(saved.json.url as string).pathname.split("/").at(-1)!;
    await revokeOrganizationMember(system, {
      organizationId,
      userId: owner.id,
      memberUserId: member.id,
    });
    // Mid-removal they make no new links.
    expect(
      (await call(memberActor, "spaces/invites/create", { spaceId: memberActor.spaceId })).status,
    ).toBe(403);
    // Mid-removal they are a guest: a new Space goes to their own organization, and nobody can
    // add them to another of this one's.
    const created = await call(memberActor, "spaces/create", { name: "Escape" });
    expect(created.status).toBe(200);
    await expect(
      system.space.findUniqueOrThrow({
        where: { id: created.json.id as string },
        select: { organizationId: true },
      }),
    ).resolves.toEqual({ organizationId: member.organizationId });
    const team = await sharedSpace(owner, "Team");
    expect(
      (
        await call({ ...owner.actor, spaceId: team }, "spaces/members/add", {
          spaceId: team,
          userId: member.id,
        })
      ).status,
    ).toBe(404);
    // Nor, owning a Space there, do they see or add the organization's people.
    const ownSpaceId = memberActor.spaceId;
    const ownList = await call(memberActor, "spaces/members/list", { spaceId: ownSpaceId });
    expect(ownList.json.addable).toEqual([]);
    expect(
      (await call(memberActor, "spaces/members/add", { spaceId: ownSpaceId, userId: owner.id }))
        .status,
    ).toBe(403);
    const list = await call(memberActor, "organizations/list", {});
    expect(
      (list.json.organizations as Array<{ id: string }>).map((organization) => organization.id),
    ).not.toContain(organizationId);

    // Rejoining before the removal finishes stops it: they keep their Spaces.
    await system.member.update({
      where: { organizationId_userId: { organizationId, userId: member.id } },
      data: { role: "member" },
    });
    await expect(
      leaveOrganizationSpaces(
        system,
        { organizationId, userId: member.id, removedBy: owner.id },
        async () => undefined,
      ),
    ).resolves.toEqual([]);
    await system.member.update({
      where: { organizationId_userId: { organizationId, userId: member.id } },
      data: { role: "guest" },
    });

    // Asking again finishes the removal.
    expect(
      (
        await call(owner.actor, "organizations/members/remove", {
          organizationId,
          userId: member.id,
        })
      ).status,
    ).toBe(200);
    // The link they saved no longer brings them back into the Space that was theirs.
    expect((await call(memberActor, "spaces/invites/accept", { token: savedToken })).status).toBe(
      404,
    );
    await expect(role(organizationId, member.id)).resolves.toBeNull();
    await expect(
      system.spaceMember.count({ where: { organizationId, userId: member.id } }),
    ).resolves.toBe(0);
  });

  it("signals each member, and only them, after every change to the members", async () => {
    const owner = await person("owner");
    const alice = await person("alice");
    const bob = await person("bob");
    const organizationId = owner.organizationId;
    const topic = (who: Person) => `organization-changes:${who.id}`;
    const signalled = async (action: () => Promise<unknown>, expected: Person[]) => {
      organizationSignals.length = 0;
      await action();
      await vi.waitFor(() =>
        expect([...new Set(organizationSignals)].sort()).toEqual(expected.map(topic).sort()),
      );
    };

    // Exactly the members hear each change: never the invitee, nor anyone removed earlier.
    // Accepting signals the member who joined as well as the ones already there.
    await signalled(() => join(owner, alice), [owner, alice]);
    let invitationId = "";
    await signalled(async () => {
      invitationId = await invite(owner, organizationId, bob.email);
    }, [owner, alice]);
    await signalled(
      () =>
        call(owner.actor, "organizations/members/setRole", {
          organizationId,
          userId: alice.id,
          role: "admin",
        }),
      [owner, alice],
    );
    // Someone removed hears it too, so their own list drops the organization.
    await signalled(
      () => call(owner.actor, "organizations/members/remove", { organizationId, userId: alice.id }),
      [owner, alice],
    );
    await signalled(
      () => call(owner.actor, "organizations/invitations/cancel", { organizationId, invitationId }),
      [owner],
    );
  });
});
