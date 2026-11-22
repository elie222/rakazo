import type { BackgroundJob, BackgroundJobPayloads } from "@rakazo/adapter-kit";
import {
  BillingEmulator,
  createLifecycleEmailSender,
  EmailEmulator,
  LIFECYCLE_EMAIL_GAP_MS,
} from "@rakazo/adapters";
import { writeEmailCopyDir } from "@rakazo/auth/test-email-copy";
import type { Actor } from "@rakazo/contracts";
import { LIFECYCLE_EMAIL_KINDS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, billingAccountForOrganization, claimProductEmail, createDb } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBillingService } from "../billing/billing.js";
import {
  AGENT_IMPORT_EMAIL_DELAY_MS,
  lifecycleEmailScheduler,
  MODEL_CONNECTION_EMAIL_DELAY_MS,
} from "./lifecycle-email.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
const WEB_ORIGIN = "https://app.example.test";
type LifecycleJob = BackgroundJobPayloads["email.lifecycle"];

dbTests("model connection email", () => {
  const stamp = `connect-${process.pid}-${Date.now()}`;
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

  const copyDir = writeEmailCopyDir({ "model-connection": true, "agent-import": true });
  beforeEach(() => {
    vi.stubEnv("EMAIL_COPY_DIR", copyDir);
  });

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    billing = createBillingService({
      prisma,
      provider,
      webOrigin: WEB_ORIGIN,
      scheduleLifecycleEmail: lifecycleEmailScheduler({
        kinds: LIFECYCLE_EMAIL_KINDS,
        prisma,
        jobs,
        webOrigin: WEB_ORIGIN,
        origin: WEB_ORIGIN,
        secret: "test-auth-secret-at-least-32-characters",
      }),
    });
    send = createLifecycleEmailSender({
      kinds: LIFECYCLE_EMAIL_KINDS,
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

  /** An owner whose own-key trial just started, and the job that start queued. */
  async function subscriber(label: string, service = billing) {
    const id = `${stamp}-${label}`;
    ids.push(id);
    const actor: Actor = {
      userId: id,
      spaceId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const createdAt = new Date();
    await prisma.user.create({
      data: { id, name: "Alex", email: actor.email, emailVerified: true },
    });
    await prisma.organization.create({ data: { id, name: "Example", slug: id, createdAt } });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt },
    });
    const before = queued.length;
    await service.selectFunding(actor, "byok");
    const customer = (await billingAccountForOrganization(prisma, id))!.customerId;
    provider.completeByokCheckout(customer);
    await service.sync(customer);
    const [job, importJob] = queued.slice(before);
    return {
      id,
      actor,
      customer,
      job: job?.payload as LifecycleJob,
      importJob: importJob?.payload as LifecycleJob,
    };
  }

  const sentTo = (id: string) =>
    email.sent.filter((message) => message.to === `${id}@example.test`);
  const claims = (id: string) => prisma.emailSend.count({ where: { userId: id } });

  it("queues one job a day after an own-key plan starts and sends its mail once", async () => {
    const before = queued.length;
    const startedAt = Date.now();
    const { id, customer, job } = await subscriber("once");
    // A later sync of the same subscription is not another start.
    await billing.sync(customer);
    const added = queued.slice(before);
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({
      name: "email.lifecycle",
      replaceKey: `email.lifecycle:model-connection:${id}:${id}`,
      queueName: `email.lifecycle:${id}`,
      payload: { kind: "model-connection", organizationId: id, userId: id },
    });
    const dueIn = added[0]!.availableAt!.getTime() - startedAt;
    expect(dueIn).toBeGreaterThanOrEqual(MODEL_CONNECTION_EMAIL_DELAY_MS);
    expect(dueIn).toBeLessThan(MODEL_CONNECTION_EMAIL_DELAY_MS + 60_000);

    await Promise.all([send(job), send(job)]);
    await send(job);

    const [message, ...extra] = sentTo(id);
    expect(extra).toHaveLength(0);
    expect(message!.subject).toBe("Test subject");
    expect(message!.text).toContain(`${WEB_ORIGIN}/sign-in?next=%2Fonboarding%2Fmodel`);
    expect(message!.text).toContain("Test connect ChatGPT or Claude");
    expect(message!.headers).toEqual({
      "List-Unsubscribe": expect.stringContaining(
        `${WEB_ORIGIN}/api/v1/email/unsubscribe?user=${id}&token=`,
      ),
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(capture.mock.calls.filter(([userId]) => userId === id)).toEqual([
      [id, { name: "lifecycle_email_sent", email: "model-connection" }],
    ]);
  });

  it("drops the job once the owner has connected a model", async () => {
    const { id, job } = await subscriber("connected");
    await prisma.userModelCredential.create({
      data: { userId: id, provider: "example-provider", label: "Key", secretId: `${id}-secret` },
    });
    await send(job);
    expect(sentTo(id)).toHaveLength(0);
    expect(await claims(id)).toBe(0);
  });

  it.each(["canceled", "unpaid"] as const)("drops the job when the plan is %s", async (status) => {
    const { id, customer, job } = await subscriber(`ended-${status}`);
    provider.setStatus(customer, status);
    await billing.sync(customer);
    await send(job);
    expect(sentTo(id)).toHaveLength(0);
    expect(await claims(id)).toBe(0);
  });

  it("drops the job for an organization that runs on hosted credits", async () => {
    const chose = await subscriber("credits-mode");
    await prisma.modelCreditAccount.upsert({
      where: { organizationId: chose.id },
      create: { organizationId: chose.id, mode: "credits" },
      update: { mode: "credits" },
    });
    const funded = await subscriber("credits-balance");
    await prisma.modelCreditAccount.upsert({
      where: { organizationId: funded.id },
      create: { organizationId: funded.id, balanceMicros: 1n },
      update: { mode: null, balanceMicros: 1n },
    });
    await send(chose.job);
    await send(funded.job);
    expect([...sentTo(chose.id), ...sentTo(funded.id)]).toHaveLength(0);
  });

  it("still reminds an own-key organization that kept a credit balance", async () => {
    const { id, job } = await subscriber("own-key-balance");
    await prisma.modelCreditAccount.upsert({
      where: { organizationId: id },
      create: { organizationId: id, mode: "byok", balanceMicros: 1n },
      update: { mode: "byok", balanceMicros: 1n },
    });
    await send(job);
    expect(sentTo(id)).toHaveLength(1);
  });

  it("writes only to a verified, active owner who has not opted out, of an organization that is staying", async () => {
    const optedOut = await subscriber("opted-out");
    await prisma.user.update({
      where: { id: optedOut.id },
      data: { marketingEmailOptOutAt: new Date() },
    });
    const unverified = await subscriber("unverified");
    await prisma.user.update({ where: { id: unverified.id }, data: { emailVerified: false } });
    const deactivated = await subscriber("deactivated");
    await prisma.user.update({
      where: { id: deactivated.id },
      data: { deactivatedAt: new Date() },
    });
    const demoted = await subscriber("demoted");
    await prisma.member.update({ where: { id: demoted.id }, data: { role: "member" } });
    const guest = await subscriber("guest");
    await prisma.member.update({ where: { id: guest.id }, data: { role: "guest" } });
    const deleting = await subscriber("deleting");
    await prisma.space.update({ where: { id: deleting.id }, data: { deletingAt: new Date() } });
    const deleted = await subscriber("deleted");
    await prisma.organization.delete({ where: { id: deleted.id } });

    const dropped = [optedOut, unverified, deactivated, demoted, guest, deleting, deleted];
    for (const { job } of dropped) await send(job);
    expect(dropped.flatMap(({ id }) => sentTo(id))).toHaveLength(0);
  });

  it("moves a mail that falls within a day of the person's last one to the end of that day", async () => {
    const { id, job } = await subscriber("gap");
    const lastSentAt = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.emailSend.create({
      data: { userId: id, kind: "another-kind", sentAt: lastSentAt },
    });
    const before = queued.length;
    await send(job);
    expect(sentTo(id)).toHaveLength(0);
    expect(queued.slice(before)).toEqual([
      expect.objectContaining({
        name: "email.lifecycle",
        payload: job,
        replaceKey: `email.lifecycle:model-connection:${id}:${id}`,
        availableAt: new Date(lastSentAt.getTime() + LIFECYCLE_EMAIL_GAP_MS),
      }),
    ]);

    await prisma.emailSend.updateMany({
      where: { userId: id },
      data: { sentAt: new Date(Date.now() - LIFECYCLE_EMAIL_GAP_MS - 1000) },
    });
    await send(job);
    expect(sentTo(id)).toHaveLength(1);
  });

  it("lets only one of two different mails racing for the same person through", async () => {
    const { id } = await subscriber("race");
    const claims = await Promise.all(
      ["first-kind", "second-kind"].map((kind) =>
        claimProductEmail(db.prisma, { userId: id, kind }, LIFECYCLE_EMAIL_GAP_MS),
      ),
    );
    expect(claims.filter((claim) => claim === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => typeof claim === "object")).toHaveLength(1);
  });

  it("never repeats a mail whose delivery failed after it was claimed", async () => {
    const { id, job } = await subscriber("failed");
    email.failNextSends(1);
    await send(job);
    await send(job);
    expect(sentTo(id)).toHaveLength(0);
    expect(await claims(id)).toBe(1);
    expect(capture.mock.calls.filter(([userId]) => userId === id)).toHaveLength(0);
  });

  it("queues the import mail two days after any plan starts and sends it once", async () => {
    const before = queued.length;
    const startedAt = Date.now();
    const { id, importJob } = await subscriber("import");
    const added = queued.slice(before);
    expect(added[1]).toMatchObject({
      name: "email.lifecycle",
      replaceKey: `email.lifecycle:agent-import:${id}:${id}`,
      payload: { kind: "agent-import", organizationId: id, userId: id },
    });
    const dueIn = added[1]!.availableAt!.getTime() - startedAt;
    expect(dueIn).toBeGreaterThanOrEqual(AGENT_IMPORT_EMAIL_DELAY_MS);
    expect(dueIn).toBeLessThan(AGENT_IMPORT_EMAIL_DELAY_MS + 60_000);

    await send(importJob);
    await send(importJob);
    const [message, ...extra] = sentTo(id);
    expect(extra).toHaveLength(0);
    expect(message!.subject).toBe("Test subject");
    expect(message!.text).toContain(`${WEB_ORIGIN}/sign-in?next=%2Fapp%3Fimport`);
  });

  it("holds the import mail back a day when the model mail has just gone out", async () => {
    const { id, job, importJob } = await subscriber("import-after-model");
    await send(job);
    const before = queued.length;
    await send(importJob);
    expect(sentTo(id)).toHaveLength(1);
    expect(queued.slice(before)).toEqual([
      expect.objectContaining({ name: "email.lifecycle", payload: importJob }),
    ]);
  });

  it("drops the import mail once the owner has imported an agent, or the plan has ended", async () => {
    const imported = await subscriber("import-done");
    const bot = await prisma.bot.create({
      data: { spaceId: imported.id, userId: imported.id, name: "Bramble", color: "ink" },
    });
    await prisma.agentImport.create({
      data: {
        spaceId: imported.id,
        userId: imported.id,
        botId: bot.id,
        source: "document",
        created: {},
      },
    });
    const ended = await subscriber("import-ended");
    provider.setStatus(ended.customer, "canceled");
    await billing.sync(ended.customer);
    await send(imported.importJob);
    await send(ended.importJob);
    expect([...sentTo(imported.id), ...sentTo(ended.id)]).toHaveLength(0);
  });

  it("queues nothing where account mail is not configured", async () => {
    const withoutMail = createBillingService({ prisma, provider, webOrigin: WEB_ORIGIN });
    const before = queued.length;
    const { job } = await subscriber("no-mail", withoutMail);
    expect(job).toBeUndefined();
    expect(queued).toHaveLength(before);
  });

  it("neither queues nor sends an email whose copy is off", async () => {
    const importOnly = createBillingService({
      prisma,
      provider,
      webOrigin: WEB_ORIGIN,
      scheduleLifecycleEmail: lifecycleEmailScheduler({
        kinds: ["agent-import"],
        prisma,
        jobs,
        webOrigin: WEB_ORIGIN,
        origin: WEB_ORIGIN,
        secret: "test-auth-secret-at-least-32-characters",
      }),
    });
    const before = queued.length;
    await subscriber("copy-off", importOnly);
    expect(queued.slice(before).map((queuedJob) => queuedJob.payload)).toEqual([
      expect.objectContaining({ kind: "agent-import" }),
    ]);

    const { id, job: connectJob } = await subscriber("copy-off-send");
    const importSender = createLifecycleEmailSender({
      kinds: ["agent-import"],
      prisma,
      email,
      jobs,
    });
    await importSender(connectJob);
    expect(sentTo(id)).toHaveLength(0);
  });
});
