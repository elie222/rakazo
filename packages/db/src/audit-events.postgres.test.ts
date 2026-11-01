import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditLogOrganization,
  installAuditEventStore,
  listAuditEvents,
  pruneAuditEvents,
  recordAuditEvent,
} from "./audit-events.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("audit events (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `audit-org-${suffix}`;
  const spaceId = `audit-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    installAuditEventStore(prisma);
    close = async () => {
      installAuditEventStore(undefined);
      await prisma.auditEvent.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: { startsWith: `audit-user-${suffix}` } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: { id: organizationId, name: "Acme", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Support" } });
    for (const role of ["owner", "admin", "member"]) {
      const userId = `audit-user-${suffix}-${role}`;
      await prisma.user.create({
        data: { id: userId, name: role, email: `${role}-${suffix}@example.test` },
      });
      await prisma.member.create({
        data: { id: userId, organizationId, userId, role, createdAt: new Date() },
      });
    }
  });

  afterAll(async () => close?.());

  it("keeps a space's history after the space, its chats, and its runs are deleted", async () => {
    await recordAuditEvent({
      action: "tool.call",
      actor: { type: "bot", id: `audit-bot-${suffix}`, label: "Researcher" },
      spaceId,
      target: { type: "tool", id: "gmail_send", label: "Gmail send" },
      runId: `audit-run-${suffix}`,
      threadId: `audit-thread-${suffix}`,
    });
    await prisma.space.delete({ where: { id: spaceId } });

    const page = await listAuditEvents(prisma, organizationId, { spaceId, limit: 10 });
    expect(page.events).toEqual([
      expect.objectContaining({
        action: "tool.call",
        spaceName: "Support",
        actorLabel: "Researcher",
        runId: `audit-run-${suffix}`,
        threadId: `audit-thread-${suffix}`,
      }),
    ]);
  });

  it("rejects rewriting an event", async () => {
    const row = await prisma.auditEvent.create({
      data: { organizationId, actorType: "system", action: "test.append_only", outcome: "success" },
    });
    await expect(
      prisma.auditEvent.update({ where: { id: row.id }, data: { outcome: "failure" } }),
      // The runtime login has no UPDATE grant; an owner connection hits the trigger.
    ).rejects.toThrow(/permission denied|append-only/);
  });

  it("prunes past the retention window and keeps recent events", async () => {
    const now = new Date();
    await prisma.auditEvent.createMany({
      data: [
        {
          organizationId,
          actorType: "system",
          action: "test.old",
          outcome: "success",
          createdAt: new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000),
        },
        { organizationId, actorType: "system", action: "test.new", outcome: "success" },
      ],
    });
    await pruneAuditEvents(prisma, 365, now);
    const remaining = await prisma.auditEvent.findMany({
      where: { organizationId, action: { in: ["test.old", "test.new"] } },
      select: { action: true },
    });
    expect(remaining).toEqual([{ action: "test.new" }]);
  });

  it("lets only the organization's owners and admins read it", async () => {
    await prisma.space.create({
      data: { id: `${spaceId}-current`, organizationId, name: "Current" },
    });
    const reader = (role: string) =>
      auditLogOrganization(prisma, {
        userId: `audit-user-${suffix}-${role}`,
        spaceId: `${spaceId}-current`,
      });
    expect(await reader("owner")).toBe(organizationId);
    expect(await reader("admin")).toBe(organizationId);
    expect(await reader("member")).toBeNull();
    expect(await reader("stranger")).toBeNull();
  });
});
