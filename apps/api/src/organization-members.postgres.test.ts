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
  OwnedOrganizationHasMembersError,
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
      events: { ...createThreadEvents(prisma), notify: vi.fn(async () => undefined) },
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin,
        screenProxySecret: "fake-test-secret",
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

    // Inviting the same address again renews it rather than adding another.
    const again = await call(owner.actor, "organizations/invitations/create", {
      organizationId,
      email: invitee.email,
    });
    expect(again.json.url).toBe(created.json.url);

    // Someone else holding the link learns nothing and cannot join.
    for (const path of ["preview", "accept"]) {
      const refused = await call(stranger.actor, `organizations/invitations/${path}`, {
        invitationId,
      });
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.json)).not.toContain(invitee.email);
    }

    const preview = await call(invitee.actor, "organizations/invitations/preview", {
      invitationId,
    });
    expect(preview.json).toEqual({ organizationName: "Personal", inviterName: "owner" });

    const accepted = await call(invitee.actor, "organizations/invitations/accept", {
      invitationId,
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
      (await call(invitee.actor, "organizations/invitations/accept", { invitationId })).status,
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
    // A server that sends no email verifies nobody, so the link sent to the address is the proof.
    await expect(
      acceptOrganizationInvitation(system, {
        invitationId: unproven,
        userId: unverified.id,
        requireVerifiedEmail: false,
      }),
    ).resolves.toMatchObject({ organizationId: owner.organizationId });
    await expect(role(owner.organizationId, unverified.id)).resolves.toEqual({ role: "member" });
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
    expect((await call(memberActor, "organizations/members/list", { organizationId })).status).toBe(
      404,
    );
  });
});
