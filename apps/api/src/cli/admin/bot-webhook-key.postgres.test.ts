import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createSecretStore } from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core/node/secrets-guard";
import { asSystem, bootstrapUserSpace, createDb } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountWebhookHttpRoutes } from "../../webhooks/webhook.js";

const run = promisify(execFile);
const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const dbTests = databaseUrl ? describe : describe.skip;

dbTests("operator admin bot webhook-key command", { timeout: 120_000 }, () => {
  let db: ReturnType<typeof createDb>;
  const userId = randomUUID();
  beforeAll(() => {
    db = createDb(databaseUrl!);
  });
  afterAll(async () => {
    const system = asSystem(db.prisma);
    await system.securityEvent.deleteMany({ where: { userId } });
    await system.organization.deleteMany({ where: { members: { some: { userId } } } });
    await system.user.deleteMany({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  const command = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "apps/api/src/cli/admin.ts", ...args], {
      env: { ...process.env, API_URL: "https://app.example.test" },
    });

  it("issues a key the webhook route accepts, never reprints it, and rotates it", async () => {
    const system = asSystem(db.prisma);
    await system.user.create({
      data: { id: userId, name: "Fixture", email: `${userId}@example.test` },
    });
    const { spaceId } = await bootstrapUserSpace(system, { id: userId });
    const bot = await system.bot.create({
      data: { spaceId, userId, name: "Scout", color: "blue" },
    });
    await system.thread.create({ data: { spaceId, userId, botId: bot.id } });

    const secrets = createSecretStore(resolveEncryptionKey(process.env));
    await secrets.start();
    const app = new Hono();
    mountWebhookHttpRoutes(app, {
      prisma: system,
      secrets,
      events: {
        sendUserMessage: () => Promise.reject(new Error("no routine should run")),
        notify: () => Promise.reject(new Error("no message should be posted")),
        publishChatAlert: () => Promise.reject(new Error("no message should be posted")),
      },
      jobs: { enqueue: () => Promise.reject(new Error("no job should be queued")) },
      linkSchemes: ["https"],
    });
    const deliver = (key: string) =>
      app.request(`/api/v1/bots/${bot.id}/webhook`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: "{}",
      });

    try {
      const url = `https://app.example.test/api/v1/bots/${bot.id}/webhook`;
      const created = JSON.parse((await command("bot", "webhook-key", bot.id, "--json")).stdout);
      expect(created).toEqual({ botId: bot.id, url, key: expect.any(String), created: true });
      expect((await deliver(created.key)).status).toBe(200);
      expect((await deliver("not-the-key")).status).toBe(401);

      const again = await command("bot", "webhook-key", bot.id);
      expect(again.stdout).toBe(
        `${url}\nThis bot already has a webhook key. --rotate replaces it.\n`,
      );
      expect(again.stdout).not.toContain(created.key);

      const rotated = JSON.parse(
        (await command("bot", "webhook-key", bot.id, "--rotate", "--json")).stdout,
      );
      expect(rotated.key).not.toBe(created.key);
      expect((await deliver(rotated.key)).status).toBe(200);
      expect((await deliver(created.key)).status).toBe(401);

      const events = await system.securityEvent.findMany({
        where: { userId, type: "credential.changed" },
      });
      expect(events.map((event) => event.metadata)).toEqual([
        { procedure: "admin.bot.webhookKey", kind: "webhook", botId: bot.id, by: "operator" },
        { procedure: "admin.bot.webhookKey", kind: "webhook", botId: bot.id, by: "operator" },
      ]);
      const audit = await system.auditEvent.findMany({
        where: { spaceId, action: "credential.changed" },
      });
      expect(audit).toHaveLength(2);
      for (const row of audit) {
        expect(row).toMatchObject({ actorType: "system", actorId: null, actorLabel: "operator" });
      }
    } finally {
      await secrets.close();
    }
  });

  it("refuses an unknown bot and bad arguments", async () => {
    await expect(command("bot", "webhook-key", "missing-bot")).rejects.toMatchObject({
      code: 1,
      stderr: "No bot has that id\n",
    });
    await expect(command("bot", "webhook-key")).rejects.toMatchObject({ code: 2 });
  });
});
