import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBoard } from "./board.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("board creation (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `board-organization-${suffix}`;
  const spaceId = `board-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: { id: organizationId, name: "Board Org", slug: organizationId, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await close();
  });
  it("allows concurrent first opens and returns the same board", async () => {
    const boards = await Promise.all(Array.from({ length: 8 }, () => ensureBoard(prisma, spaceId)));
    expect(new Set(boards.map((board) => board.id)).size).toBe(1);
    expect(boards.every((board) => board.name === "General")).toBe(true);
    expect(await prisma.board.count({ where: { spaceId } })).toBe(1);
  });
});
