import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  ComputerRef,
  UnreferencedMachine,
  UnreferencedMachineRecords,
} from "@rakazo/adapter-kit";
import { machineCleanupJobKey } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSandboxProvider } from "../providers/computer/fake/fake-sandbox.js";
import { GraphileJobPublisher } from "../runs/wakeups/wakeup.js";
import { LocalAgentHomeStore } from "../storage/home.js";
import { provisionComputer } from "./computer-lifecycle.js";
import { machineCleanupRecords, retryMachineCleanup } from "./machine-cleanup.js";
import { recordUnreferencedMachine } from "./sandbox/sandbox-cleanup.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

/** The fake provider, recording each machine it creates as a remote provider does. */
class RecordingSandbox extends FakeSandboxProvider {
  readonly deleteMachine = vi.fn(async (machine: UnreferencedMachine) => {
    this.boxes.delete(machine.machineId);
  });
  private readonly records: UnreferencedMachineRecords;

  constructor(records: UnreferencedMachineRecords) {
    super();
    this.records = records;
  }

  override async provision(
    request: { botId: string; homePath: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const ref = await super.provision(request, context);
    if (ref.fresh)
      await recordUnreferencedMachine(this.records, {
        provider: ref.kind,
        machineId: ref.providerRef,
        homeKey: request.botId,
      });
    return ref;
  }
}

describePostgres("machine cleanup (PostgreSQL)", () => {
  const address = `machines-${randomUUID()}@example.test`;
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let jobs: GraphileJobPublisher;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let computerId: string;
  let machine: UnreferencedMachine;
  let key: string;
  let dataDir: string;
  let sandbox: RecordingSandbox;

  const row = () => prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  const queued = async () =>
    (await db.pool.query("select 1 from graphile_worker._private_jobs where key = $1", [key]))
      .rowCount === 1;
  const cleanup = () => retryMachineCleanup({ prisma: db.prisma, sandbox }, machine);
  // As a run starts it: scoped to its Space, with the queue the deployment uses.
  const start = () =>
    runAsTenant({ spaceId: identity.spaceId, userId: identity.userId }, () =>
      provisionComputer(
        {
          prisma: db.prisma,
          sandbox,
          home: new LocalAgentHomeStore(dataDir),
          jobs,
          events: { append: vi.fn() } as unknown as ThreadEvents,
          dataDir,
        },
        computerId,
        {
          operationId: "start",
          traceId: "start",
          spaceId: identity.spaceId,
          userId: identity.userId,
          botId: identity.botId,
          signal: new AbortController().signal,
        },
      ),
    );

  beforeAll(async () => {
    db = createDb(url!);
    prisma = asSystem(db.prisma);
    jobs = new GraphileJobPublisher(db.pool, db.prisma);
    identity = await runAsSystem("machine cleanup fixture", () =>
      provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: identity.botId } });
    computerId = bot.computerId!;
    const { homeKey } = await row();
    machine = { provider: "fake", machineId: `fake-${homeKey}`, homeKey };
    key = machineCleanupJobKey(machine.provider, machine.machineId);
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-machine-cleanup-"));
    sandbox = new RecordingSandbox(machineCleanupRecords(jobs));
    await prisma.computerExecutionLease.deleteMany({ where: { computerId } });
    await prisma.computer.update({
      where: { id: computerId },
      data: { kind: "fake", state: "stopped", providerRef: null, restorePending: false },
    });
    await jobs.cancel(key);
  });

  afterEach(async () => {
    vi.useRealTimers();
    sandbox.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (!db) return;
    await jobs.cancel(key).catch(() => undefined);
    await jobs.close();
    await prisma.messagingIdentity.deleteMany({ where: { address } });
    if (identity) {
      await prisma.organization.deleteMany({ where: { id: identity.spaceId } });
      await prisma.user.deleteMany({ where: { id: identity.userId } });
    }
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("waits out the start, keeps the machine a computer stores, and deletes one no computer kept", async () => {
    await prisma.computer.update({ where: { id: computerId }, data: { state: "booting" } });
    await expect(cleanup()).rejects.toThrow("still in progress");

    await prisma.computer.update({
      where: { id: computerId },
      data: { state: "running", providerRef: machine.machineId },
    });
    await cleanup();
    expect(sandbox.deleteMachine).not.toHaveBeenCalled();

    await prisma.computer.update({
      where: { id: computerId },
      data: { providerRef: `${machine.machineId}-replacement` },
    });
    await cleanup();
    expect(sandbox.deleteMachine).toHaveBeenCalledWith(machine, expect.any(AbortSignal));
  });

  it("leaves no job behind a start that succeeds, and a late job still deletes nothing", async () => {
    // The record is there while the start still runs.
    vi.spyOn(sandbox, "prepare").mockImplementationOnce(async () => {
      expect(await queued()).toBe(true);
    });

    await start();

    expect(await row()).toMatchObject({ state: "running", providerRef: machine.machineId });
    expect(await queued()).toBe(false);

    // A record whose removal was missed: the job reads that a computer stores the machine.
    await recordUnreferencedMachine(machineCleanupRecords(jobs), machine);
    await cleanup();
    expect(sandbox.deleteMachine).not.toHaveBeenCalled();
    expect(sandbox.boxes.has(machine.machineId)).toBe(true);
  });

  it("keeps the job behind a start that fails, and the job finds the machine deleted", async () => {
    vi.spyOn(sandbox, "prepare").mockRejectedValueOnce(new Error("setup failed"));

    await expect(start()).rejects.toThrow("setup failed");

    expect(await row()).toMatchObject({ state: "error", providerRef: null });
    expect(sandbox.boxes.has(machine.machineId)).toBe(false);
    expect(await queued()).toBe(true);
    await cleanup();
    expect(sandbox.deleteMachine).toHaveBeenCalledWith(machine, expect.any(AbortSignal));
  });

  it("drops the job when a failed start stores the machine it could not delete", async () => {
    vi.spyOn(sandbox, "prepare").mockRejectedValueOnce(new Error("setup failed"));
    vi.spyOn(sandbox, "destroy").mockRejectedValueOnce(new Error("provider deletion failed"));

    await expect(start()).rejects.toThrow();

    expect(await row()).toMatchObject({
      state: "error",
      providerRef: machine.machineId,
      restorePending: true,
    });
    expect(await queued()).toBe(false);
    expect(sandbox.boxes.has(machine.machineId)).toBe(true);
  });

  it("waits for a start it has not heard from, and leaves its computer alone", async () => {
    await prisma.computer.update({
      where: { id: computerId },
      data: { state: "booting", updatedAt: new Date(Date.now() - 30 * 60_000) },
    });

    await expect(cleanup()).rejects.toThrow("still in progress");

    expect(await row()).toMatchObject({ state: "booting" });
    expect(sandbox.deleteMachine).not.toHaveBeenCalled();
  });
});
