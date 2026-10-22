import type {
  AgentHomeStore,
  AgentRuntime,
  SandboxProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import type { createRunExecutor } from "./executor.js";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "./wakeup.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the owner,
// as `pnpm test:integration` provides.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

describePostgres("tenant-scoped background jobs (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `tenant-jobs-org-${suffix}`;
  const tenants = ["a", "b"].map((name) => ({
    name,
    userId: `tenant-jobs-user-${name}-${suffix}`,
    spaceId: `tenant-jobs-space-${name}-${suffix}`,
    botId: `tenant-jobs-bot-${name}-${suffix}`,
    threadId: `tenant-jobs-thread-${name}-${suffix}`,
    runId: `tenant-jobs-run-${name}-${suffix}`,
  }));
  const [a, b] = tenants as [(typeof tenants)[0], (typeof tenants)[0]];
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;

  beforeAll(() => runAsSystem("test fixture", seed));

  async function seed() {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 6 });
    const o = owner.prisma;
    await o.organization.create({
      data: { id: organizationId, name: "Jobs", slug: organizationId, createdAt: new Date() },
    });
    for (const t of tenants) {
      await o.user.create({
        data: { id: t.userId, name: t.name, email: `${t.userId}@rakazo.test`, emailVerified: true },
      });
      await o.space.create({ data: { id: t.spaceId, organizationId, name: t.name } });
      await o.bot.create({
        data: { id: t.botId, spaceId: t.spaceId, userId: t.userId, name: t.name, color: "#000" },
      });
      await o.thread.create({
        data: { id: t.threadId, spaceId: t.spaceId, userId: t.userId, botId: t.botId },
      });
      await o.message.create({
        data: { threadId: t.threadId, seq: 1, role: "user", blocks: [{ text: t.name }] },
      });
      await o.connection.create({
        data: {
          spaceId: t.spaceId,
          userId: t.userId,
          provider: "test",
          displayName: t.name,
          status: "connected",
        },
      });
      const task = await o.task.create({
        data: {
          spaceId: t.spaceId,
          botId: t.botId,
          threadId: t.threadId,
          userId: t.userId,
          prompt: "p",
          status: "queued",
        },
      });
      await o.run.create({
        data: {
          id: t.runId,
          spaceId: t.spaceId,
          botId: t.botId,
          threadId: t.threadId,
          taskId: task.id,
          userId: t.userId,
          status: "queued",
          trigger: "created",
        },
      });
    }
  }

  afterAll(async () => {
    if (!owner) return;
    await owner.prisma.organization.deleteMany({ where: { id: organizationId } });
    await owner.prisma.user.deleteMany({ where: { id: { in: tenants.map((t) => t.userId) } } });
    for (const handle of [owner, app]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  /** A run whose tool forgets every filter: it sees only what the database lets it. */
  function careless(prisma: PrismaClient) {
    const seen = new Map<string, { messages: string[]; connections: string[] }>();
    const ours = (ids: string[], key: "threadId" | "spaceId") =>
      [...new Set(ids)].filter((id) => tenants.some((t) => t[key] === id));
    const continueRun = vi.fn(async (runId: string) => {
      const messages = await prisma.message.findMany({ select: { threadId: true } });
      const connections = await prisma.connection.findMany({ select: { spaceId: true } });
      seen.set(runId, {
        messages: ours(
          messages.map((row) => row.threadId),
          "threadId",
        ),
        connections: ours(
          connections.map((row) => row.spaceId),
          "spaceId",
        ),
      });
    });
    const handlers = createBackgroundJobHandlers({
      executor: { continueRun } as unknown as ReturnType<typeof createRunExecutor>,
      prisma,
      sandbox: {} as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: { enqueue: vi.fn(async () => undefined) } as never,
      events: {} as ThreadEvents,
      workerId: "tenant-jobs",
      runtime: {} as AgentRuntime,
      secretStore: {} as SecretStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
    });
    return { handlers, seen, continueRun };
  }

  it("limits a run's unscoped reads to the run's own Space", async () => {
    const { handlers, seen } = careless(app.prisma);
    await handlers["run.continue"]({ runId: a.runId });
    await handlers["run.continue"]({ runId: b.runId });
    expect(seen.get(a.runId)).toEqual({ messages: [a.threadId], connections: [a.spaceId] });
    expect(seen.get(b.runId)).toEqual({ messages: [b.threadId], connections: [b.spaceId] });
  });

  it("runs tenant jobs through the Graphile queue", async () => {
    const { handlers, seen, continueRun } = careless(app.prisma);
    const publisher = new GraphileJobPublisher(app.pool);
    const host = new GraphileJobWorkerHost(app.pool, { concurrency: 2, pollInterval: 25 });
    try {
      await host.start(handlers);
      for (const t of tenants) {
        await publisher.enqueue({ name: "run.continue", payload: { runId: t.runId } });
      }
      // A job whose run is gone has nothing to act on and completes.
      await publisher.enqueue({ name: "run.continue", payload: { runId: `gone-${suffix}` } });
      await vi.waitFor(() => expect(seen.size).toBe(2), { timeout: 10_000, interval: 25 });
      expect(seen.get(a.runId)).toEqual({ messages: [a.threadId], connections: [a.spaceId] });
      expect(seen.get(b.runId)).toEqual({ messages: [b.threadId], connections: [b.spaceId] });
      await vi.waitFor(
        async () => {
          const pending = await owner.pool.query(
            `SELECT count(*)::int AS count FROM graphile_worker._private_jobs j
             JOIN graphile_worker._private_tasks t ON t.id = j.task_id
             WHERE t.identifier = 'run.continue' AND j.payload::text LIKE $1`,
            [`%${suffix}%`],
          );
          expect(pending.rows[0].count).toBe(0);
        },
        { timeout: 10_000, interval: 50 },
      );
      expect(continueRun).toHaveBeenCalledTimes(2);
    } finally {
      await host.stop();
      await publisher.close();
    }
  });
});
