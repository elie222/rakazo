import { randomUUID } from "node:crypto";
import type { NotificationProvider, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createOrganizationForUser,
  createThreadEvents,
  readMessageBlocks,
  runAsSystem,
} from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mountWebhookHttpRoutes, WEBHOOK_SECRET_KIND } from "./webhook.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const TOKEN = "webhook-post-token";

describePostgres("webhook post (PostgreSQL)", () => {
  let runtime: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const userId = `user-${randomUUID()}`;
  let spaceId: string;

  beforeAll(async () => {
    runtime = createDb(process.env.DATABASE_URL!);
    system = asSystem(runtime.prisma);
    await system.user.create({
      data: { id: userId, name: "Owner", email: `${userId}@rakazo.test`, emailVerified: true },
    });
    spaceId = (await createOrganizationForUser(system, { userId, name: "Posts" })).defaultSpaceId;
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { members: { some: { userId } } } });
    await system.user.deleteMany({ where: { id: userId } });
    await runtime?.prisma.$disconnect();
    await runtime?.pool.end();
  });

  it("posts the text and buttons as the bot without a routine or run, and pushes it", async () => {
    const secret = await system.secret.create({
      data: { userId, spaceId, kind: WEBHOOK_SECRET_KIND, ciphertext: "sealed" },
    });
    const bot = await system.bot.create({
      data: {
        spaceId,
        userId,
        name: "Fleet",
        color: "ink",
        webhookSecretId: secret.id,
        thread: { create: { spaceId, userId } },
      },
      select: { id: true, thread: { select: { id: true } } },
    });
    const send = vi.fn(async () => undefined);
    const app = new Hono();
    app.use("/api/v1/bots/*", (_c, next) => runAsSystem("bot webhook", next));
    mountWebhookHttpRoutes(app, {
      prisma: runtime.prisma,
      secrets: { load: async () => TOKEN } as unknown as SecretStore,
      events: createThreadEvents(runtime.prisma),
      jobs: { enqueue: vi.fn() },
      notifications: { send } as unknown as NotificationProvider,
      linkSchemes: ["https", "app"],
    });
    const buttons = [{ label: "Open", url: "app://threads/env-1/thread-1" }];

    const response = await app.request(`/api/v1/bots/${bot.id}/webhook`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ post: { text: "Build **finished**", buttons } }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; messageId: string };
    expect(body.ok).toBe(true);
    const message = await system.message.findUniqueOrThrow({
      where: { id: body.messageId },
      select: { id: true, threadId: true, role: true, botId: true, runId: true, blocks: true },
    });
    expect(message).toMatchObject({ threadId: bot.thread!.id, role: "bot", botId: bot.id });
    expect(message.runId).toBeNull();
    expect(readMessageBlocks(message).blocks).toEqual([
      { kind: "post", markdown: "Build **finished**" },
      { kind: "buttons", buttons },
    ]);
    expect(await system.run.count({ where: { botId: bot.id } })).toBe(0);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "completion",
          title: "Fleet",
          body: "Build finished",
          threadId: bot.thread!.id,
        }),
        expect.objectContaining({ userId }),
      ),
    );
  });
});
