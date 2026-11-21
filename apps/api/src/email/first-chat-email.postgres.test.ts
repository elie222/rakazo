import type { BackgroundJob, BackgroundJobPayloads } from "@rakazo/adapter-kit";
import { BillingEmulator, createLifecycleEmailSender, EmailEmulator } from "@rakazo/adapters";
import type { Actor, RunTrigger } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, billingAccountForOrganization, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBillingService } from "../billing/billing.js";
import { lifecycleEmailPreparer } from "./lifecycle-email.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
const WEB_ORIGIN = "https://app.example.test";
type LifecycleJob = BackgroundJobPayloads["email.lifecycle"];

dbTests("first chat email", () => {
  const stamp = `first-chat-${process.pid}-${Date.now()}`;
  const ids: string[] = [];
  const provider = new BillingEmulator({ modelCredits: true, namespace: stamp });
  const email = new EmailEmulator();
  const queued: BackgroundJob[] = [];
  const jobs = {
    enqueue: async (job: BackgroundJob) => {
      queued.push(job);
    },
  };
  const capture = vi.fn();
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let billing: ReturnType<typeof createBillingService>;
  let send: (job: LifecycleJob) => Promise<void>;
  let prepare: ReturnType<typeof lifecycleEmailPreparer>;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    billing = createBillingService({ prisma, provider, webOrigin: WEB_ORIGIN });
    prepare = lifecycleEmailPreparer({
      prisma,
      webOrigin: WEB_ORIGIN,
      origin: WEB_ORIGIN,
      secret: "test-auth-secret-at-least-32-characters",
    });
    send = createLifecycleEmailSender({
      prisma,
      email,
      jobs,
      analytics: { capture, flush: async () => {} },
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  /** An owner on a running plan who just connected a model, and the mail that queued. */
  async function connected(label: string, locale?: string) {
    const id = `${stamp}-${label}`;
    ids.push(id);
    const actor: Actor = {
      userId: id,
      spaceId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    await prisma.user.create({
      data: { id, name: "Alex", email: actor.email, emailVerified: true, locale },
    });
    await prisma.organization.create({
      data: { id, name: "Example", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await billing.selectFunding(actor, "byok");
    const customer = (await billingAccountForOrganization(prisma, id))!.customerId;
    provider.completeByokCheckout(customer);
    await billing.sync(customer);
    await prisma.userModelCredential.create({
      data: { userId: id, provider: "example-provider", label: "Key", secretId: `${id}-secret` },
    });
    const job = await prepare("first-chat", { organizationId: id, userId: id }, new Date());
    return { id, customer, job: job!.payload as LifecycleJob };
  }

  /** A run started by a message from `author` (none for a run no message started). */
  async function runStartedBy(id: string, trigger: RunTrigger, author: string | null = id) {
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Chief", color: "ink" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId: id, userId: id, botId: bot.id },
    });
    const owner = { spaceId: id, userId: id, botId: bot.id, threadId: thread.id };
    const task = await prisma.task.create({
      data: { ...owner, prompt: "fixture", status: "completed" },
    });
    const message = author
      ? await prisma.message.create({
          data: { threadId: thread.id, seq: 0, role: "user", blocks: [], authorUserId: author },
        })
      : null;
    await prisma.run.create({
      data: {
        ...owner,
        taskId: task.id,
        status: "completed",
        trigger,
        sourceMessageId: message?.id,
      },
    });
  }

  const sentTo = (id: string) =>
    email.sent.filter((message) => message.to === `${id}@example.test`);

  it("sends once to an owner who has not sent a message, in their language", async () => {
    const { id, job } = await connected("once", "de");
    await Promise.all([send(job), send(job)]);
    await send(job);
    const [message, ...extra] = sentTo(id);
    expect(extra).toHaveLength(0);
    expect(message!.subject).toBe("Sende deine erste Nachricht");
    expect(message!.text).toContain(`${WEB_ORIGIN}/sign-in`);
    expect(message!.headers?.["List-Unsubscribe"]).toContain("/api/v1/email/unsubscribe?user=");
    expect(capture.mock.calls.filter(([userId]) => userId === id)).toEqual([
      [id, { name: "lifecycle_email_sent", email: "first-chat" }],
    ]);
  });

  it.each(["user", "messaging", "follow_up"] as const)(
    "drops the mail once the owner has sent a message (%s)",
    async (trigger) => {
      const { id, job } = await connected(`chatted-${trigger}`);
      await runStartedBy(id, trigger);
      await send(job);
      expect(sentTo(id)).toHaveLength(0);
      expect(await prisma.emailSend.count({ where: { userId: id } })).toBe(0);
    },
  );

  it.each(["routine", "webhook"] as const)(
    "still sends when only a %s has run for the owner",
    async (trigger) => {
      const { id, job } = await connected(`not-own-${trigger}`);
      await runStartedBy(id, trigger, null);
      await send(job);
      expect(sentTo(id)).toHaveLength(1);
    },
  );

  it("still sends when only someone else's message started a run for the owner", async () => {
    const { id, job } = await connected("others-message");
    await runStartedBy(id, "messaging", `${id}-coworker`);
    await runStartedBy(id, "follow_up", null);
    await send(job);
    expect(sentTo(id)).toHaveLength(1);
  });

  it("drops the mail once the owner has removed their model", async () => {
    const { id, job } = await connected("disconnected");
    await prisma.userModelCredential.deleteMany({ where: { userId: id } });
    await send(job);
    expect(sentTo(id)).toHaveLength(0);
  });

  it("drops the mail when the plan has ended", async () => {
    const { id, customer, job } = await connected("ended");
    provider.setStatus(customer, "canceled");
    await billing.sync(customer);
    await send(job);
    expect(sentTo(id)).toHaveLength(0);
  });

  it("waits a day after the model reminder before it goes out", async () => {
    const { id, job } = await connected("after-reminder");
    const lastSentAt = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.emailSend.create({
      data: { userId: id, kind: "model-connection", sentAt: lastSentAt },
    });
    const before = queued.length;
    await send(job);
    expect(sentTo(id)).toHaveLength(0);
    expect(queued.slice(before)).toEqual([
      expect.objectContaining({
        payload: job,
        replaceKey: `email.lifecycle:first-chat:${id}:${id}`,
        availableAt: new Date(lastSentAt.getTime() + 24 * 60 * 60 * 1000),
      }),
    ]);
  });
});
