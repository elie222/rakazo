import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, IsolationError } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOwnedArtifact } from "./artifacts.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("artifact upload nonce (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `artifact-nonce-user-${suffix}`;
  const organizationId = `artifact-nonce-org-${suffix}`;
  const spaceId = `artifact-nonce-space-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const stored = new Set<string>();
  let puts = 0;
  const artifacts = {
    async put() {
      puts += 1;
      const id = `blob-${puts}`;
      stored.add(id);
      return { id };
    },
    async remove(id: string) {
      stored.delete(id);
    },
  } as unknown as ArtifactStore;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let otherBotId: string;
  const upload = (clientNonce: string | undefined, target: { botId: string; groupId?: string }) =>
    createOwnedArtifact({ prisma, artifacts }, actor, {
      ...target,
      name: "notes.txt",
      mimeType: "text/plain",
      contentBase64: Buffer.from("hello").toString("base64"),
      clientNonce,
    });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Nonce Org", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    botId = (await prisma.bot.create({ data: { spaceId, userId, name: "Chief", color: "blue" } }))
      .id;
    otherBotId = (
      await prisma.bot.create({ data: { spaceId, userId, name: "Scout", color: "green" } })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("returns the artifact a retried upload already created", async () => {
    const first = await upload("send-1:0", { botId });
    const retry = await upload("send-1:0", { botId });
    expect(retry).toEqual(first);
    expect(await prisma.artifact.count({ where: { spaceId, clientNonce: "send-1:0" } })).toBe(1);
    expect(stored.size).toBe(1);
  });

  it("creates one artifact when two retries of an upload race", async () => {
    const [a, b] = await Promise.all([
      upload("send-2:0", { botId }),
      upload("send-2:0", { botId }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await prisma.artifact.count({ where: { spaceId, clientNonce: "send-2:0" } })).toBe(1);
    expect(stored.size).toBe(2);
  });

  it("replays one artifact when retries of a group upload race under different member bots", async () => {
    const group = await prisma.chatGroup.create({ data: { spaceId, userId, name: "Race" } });
    const uploads = await Promise.all(
      [botId, otherBotId, botId, otherBotId].map((member) =>
        upload("send-5:0", { botId: member, groupId: group.id }),
      ),
    );
    expect(new Set(uploads.map((artifact) => artifact.id)).size).toBe(1);
    expect(await prisma.artifact.count({ where: { spaceId, clientNonce: "send-5:0" } })).toBe(1);
  });

  it("refuses a nonce reused for another chat", async () => {
    await upload("send-3:0", { botId });
    await expect(upload("send-3:0", { botId: otherBotId })).rejects.toBeInstanceOf(IsolationError);
  });
});
