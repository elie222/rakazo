import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem, withLease } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalAgentHomeStore } from "../../storage/home.js";
import { saveReceivedFile } from "./save-received-file.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("saveReceivedFile (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string };
  let root: string;
  const address = `received-files-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("received files fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    root = await mkdtemp(path.join(tmpdir(), "rakazo-received-pg-"));
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

  it("waits for another process's save on the same computer before it picks a name", async () => {
    const homeKey = `received-files-${randomUUID()}`;
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
    const home = new LocalAgentHomeStore(root);
    const list = vi.spyOn(home, "list");
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
      `received-files:${computer.id}`,
      { ttlMs: 60_000 },
      () => elsewhere.promise,
    );
    await vi.waitFor(async () =>
      expect(await system.lease.count({ where: { key: `received-files:${computer.id}` } })).toBe(1),
    );

    const saving = saveReceivedFile(
      { prisma, home, sandbox: {} as SandboxProvider, timeZone: "UTC" },
      {
        bot: { id: "bot-1", computerId: computer.id },
        sender: "972541234567",
        mimeType: "image/jpeg",
        bytes: new Uint8Array([1]),
        at: new Date("2026-11-17T17:12:00Z"),
      },
      {
        operationId: "test",
        traceId: "test",
        spaceId: identity.spaceId,
        userId: identity.userId,
        signal: AbortSignal.timeout(30_000),
      },
    );
    // It asked for the folder again after finding it held, and looked at nothing meanwhile.
    await vi.waitFor(() => expect(takes).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    expect(list).not.toHaveBeenCalled();

    elsewhere.resolve();
    await held;
    await expect(saving).resolves.toEqual({
      saved: "shared/received/2026/11/2026-11-17_1712_972541234567_image.jpg",
    });
    expect(list).toHaveBeenCalledOnce();
    expect(await readdir(path.join(home.pathFor(homeKey), "shared/received/2026/11"))).toEqual([
      "2026-11-17_1712_972541234567_image.jpg",
    ]);
    expect(await system.lease.count({ where: { key: `received-files:${computer.id}` } })).toBe(0);
    await system.computer.delete({ where: { id: computer.id } });
  });
});
