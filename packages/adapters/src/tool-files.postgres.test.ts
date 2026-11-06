import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOL_FILE_IDLE_TTL_MS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "./artifacts.js";
import type { PrismaToolFileStore } from "./tool-files.js";
import { createToolFileStore, ToolFileNotFoundError } from "./tool-files.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

describePostgres("temporary tool files (PostgreSQL)", () => {
  const suffix = randomUUID();
  const userId = `tool-files-user-${suffix}`;
  const organizationId = `tool-files-org-${suffix}`;
  const spaceId = `tool-files-space-${suffix}`;
  const otherSpaceId = `tool-files-other-${suffix}`;
  const bytes = new TextEncoder().encode("%PDF-1.7 tool file");
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let root: string;
  let botId: string;
  let clock = new Date();
  let store: PrismaToolFileStore;
  const owner = () => ({ spaceId, userId, botId });
  const files = async () => readdir(path.join(root, "artifacts", spaceId)).catch(() => []);

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    root = await mkdtemp(path.join(tmpdir(), "tool-files-"));
    await system.user.create({
      data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Tool Files", slug: organizationId, createdAt: new Date() },
    });
    for (const [id, isDefault] of [
      [spaceId, true],
      [otherSpaceId, false],
    ] as const)
      await system.space.create({ data: { id, organizationId, name: id, isDefault } });
    botId = (await system.bot.create({ data: { spaceId, userId, name: "Clerk", color: "blue" } }))
      .id;
    store = createToolFileStore({
      prisma: db.prisma,
      // Sealed with the space's key, like every other file.
      artifacts: new LocalArtifactStore(root, db.contentKeys),
      publicBaseUrl: "http://127.0.0.1:3100",
      now: () => clock,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
    await rm(root, { recursive: true, force: true });
  });

  it("creates, reads, links and downloads a file under row-level security", async () => {
    clock = new Date();
    const file = await store.create({
      ...owner(),
      name: "a.pdf",
      mimeType: "application/pdf",
      bytes,
    });

    const read = await store.read(file.id, owner());
    expect(read.bytes).toEqual(bytes);
    await expect(store.read(file.id, { ...owner(), spaceId: otherSpaceId })).rejects.toBeInstanceOf(
      ToolFileNotFoundError,
    );

    const { url: link } = await store.signedUrl(file.id, owner());
    const token = link.slice(link.lastIndexOf("/") + 1);
    // The link's row belongs to the file's Space: another Space's tenant cannot see it.
    const visible = (space: string) =>
      runAsTenant({ spaceId: space, userId }, () =>
        db.prisma.toolFileDownloadToken.count({ where: { artifactId: file.id } }),
      );
    expect(await visible(spaceId)).toBe(1);
    expect(await visible(otherSpaceId)).toBe(0);

    const downloaded = await store.download(token);
    expect(downloaded?.bytes).toEqual(bytes);
    expect(downloaded?.file.name).toBe("a.pdf");
    expect(await store.download(`${token.slice(0, -1)}x`)).toBeUndefined();
  });

  it("sweeps expired files from disk and the database, and a second sweep finds nothing", async () => {
    clock = new Date();
    const expired = await store.create({
      ...owner(),
      name: "old.txt",
      mimeType: "text/plain",
      bytes,
    });
    await store.signedUrl(expired.id, owner());
    clock = new Date(clock.getTime() + TOOL_FILE_IDLE_TTL_MS / 2);
    const alive = await store.create({
      ...owner(),
      name: "new.txt",
      mimeType: "text/plain",
      bytes,
    });
    const keyOf = async (id: string) =>
      (await system.artifact.findUniqueOrThrow({ where: { id } })).storageKey;
    const [expiredKey, aliveKey] = [await keyOf(expired.id), await keyOf(alive.id)];
    expect(await files()).toEqual(expect.arrayContaining([expiredKey, aliveKey]));
    clock = new Date(clock.getTime() + TOOL_FILE_IDLE_TTL_MS / 2 + 1);

    const [a, b] = await Promise.all([store.sweepExpired(clock), store.sweepExpired(clock)]);

    // Earlier tests' files expired too; each is counted by exactly one sweep.
    expect(a + b).toBeGreaterThanOrEqual(1);
    expect(await system.artifact.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await system.toolFileDownloadToken.count({ where: { artifactId: expired.id } })).toBe(0);
    expect(await system.artifact.findUnique({ where: { id: alive.id } })).not.toBeNull();
    expect(await files()).toContain(aliveKey);
    expect(await files()).not.toContain(expiredKey);
    expect(await store.sweepExpired(clock)).toBe(0);
    await expect(store.read(alive.id, owner())).resolves.toMatchObject({ bytes });
  });
});
