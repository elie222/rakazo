import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem, withLease } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalAgentHomeStore } from "../../storage/home.js";
import { copyAttachmentToComputer } from "./copy-attachment.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

const STORED = "attachments/2026-11-17_1712_972541234567_image.jpg";

describePostgres("copyAttachmentToComputer (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string };
  let root: string;
  const address = `attachment-copies-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("attachment copies fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    root = await mkdtemp(path.join(tmpdir(), "rakazo-attachment-copies-pg-"));
  });

  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (root) await rm(root, { recursive: true, force: true });
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("waits for another process's copy or prune on the same computer before it writes", async () => {
    const homeKey = `attachment-copies-${randomUUID()}`;
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: homeKey,
        homeKey,
        kind: "docker",
        state: "stopped",
      },
    });
    const leases = () => system.lease.count({ where: { key: `attachment-copies:${computer.id}` } });
    const home = new LocalAgentHomeStore(root);
    const write = vi.spyOn(home, "writeBinaryFile");
    let takes = 0;
    const prisma = new Proxy(system, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "$queryRaw") return value;
        return (query: TemplateStringsArray, ...values: unknown[]) => {
          if (query.join("").includes("INSERT INTO")) takes += 1;
          return (value as PrismaClient["$queryRaw"]).call(target, query, ...values);
        };
      },
    });
    const elsewhere = deferred();
    const held = withLease(
      system,
      `attachment-copies:${computer.id}`,
      { ttlMs: 60_000 },
      () => elsewhere.promise,
    );
    await vi.waitFor(async () => expect(await leases()).toBe(1));

    const copying = copyAttachmentToComputer(
      { prisma, home, sandbox: {} as SandboxProvider },
      { bot: { id: "bot-1", computerId: computer.id }, path: STORED, bytes: new Uint8Array([1]) },
      {
        operationId: "test",
        traceId: "test",
        spaceId: identity.spaceId,
        userId: identity.userId,
        signal: AbortSignal.timeout(30_000),
      },
    );
    // It asked for the computer again after finding it held, and wrote nothing meanwhile.
    await vi.waitFor(() => expect(takes).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    expect(write).not.toHaveBeenCalled();

    elsewhere.resolve();
    await held;
    await expect(copying).resolves.toEqual({ copied: `bots/bot-1/${STORED}` });
    expect(await readFile(path.join(home.pathFor(homeKey), `bots/bot-1/${STORED}`))).toEqual(
      Buffer.from([1]),
    );
    expect(await leases()).toBe(0);
    await system.computer.delete({ where: { id: computer.id } });
  });
});
