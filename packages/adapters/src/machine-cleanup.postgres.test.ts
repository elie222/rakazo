import { randomUUID } from "node:crypto";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retryMachineCleanup } from "./machine-cleanup.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("machine cleanup (PostgreSQL)", () => {
  const id = randomUUID();
  const machine = { provider: "fake", machineId: `${id}-machine`, homeKey: id };
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    await system.user.create({
      data: { id, name: "Machine Owner", email: `${id}@example.test`, emailVerified: false },
    });
    await system.organization.create({
      data: { id, name: "Machines", slug: id, createdAt: new Date() },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Machines" } });
    await system.computer.create({
      data: { id, spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake" },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({ where: { id } });
    await system.user.deleteMany({ where: { id } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("waits out the start, keeps the machine a computer stores, and deletes one no computer kept", async () => {
    const deleteMachine = vi.fn(async () => undefined);
    const deps = { prisma: db.prisma, sandbox: { deleteMachine } as unknown as SandboxProvider };

    await system.computer.update({ where: { id }, data: { state: "booting" } });
    await expect(retryMachineCleanup(deps, machine)).rejects.toThrow("still in progress");

    await system.computer.update({
      where: { id },
      data: { state: "running", providerRef: machine.machineId },
    });
    await retryMachineCleanup(deps, machine);
    expect(deleteMachine).not.toHaveBeenCalled();

    await system.computer.update({ where: { id }, data: { providerRef: `${id}-replacement` } });
    await retryMachineCleanup(deps, machine);
    expect(deleteMachine).toHaveBeenCalledWith(machine, expect.any(AbortSignal));
  });
});
