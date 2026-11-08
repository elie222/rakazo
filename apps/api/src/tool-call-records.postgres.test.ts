import { createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLiveRunEvents } from "./thread-snapshot.js";
import { loadToolCallRecords } from "./tool-call-records.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("tool call records with CONTENT_ENCRYPTION on (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `tool-records-user-${suffix}`;
  const organizationId = `tool-records-org-${suffix}`;
  const spaceId = `tool-records-space-${suffix}`;
  const botId = `tool-records-bot-${suffix}`;
  const threadId = `tool-records-thread-${suffix}`;
  const runId = `tool-records-run-${suffix}`;
  let db: ReturnType<typeof createDb>;

  const system = <T>(work: () => Promise<T>) => runAsSystem("test fixture", work);

  beforeAll(() =>
    system(async () => {
      db = createDb(databaseUrl!, { encryptContent: true });
      const { prisma } = db;
      await prisma.user.create({
        data: { id: userId, name: userId, email: `${userId}@rakazo.test`, emailVerified: false },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Tools", slug: organizationId, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "General" } });
      await prisma.bot.create({ data: { id: botId, spaceId, userId, name: "Ada", color: "ink" } });
      await prisma.thread.create({ data: { id: threadId, spaceId, userId, botId } });
      const events = [
        {
          type: "agent.tool.called",
          payload: {
            name: "shell",
            executionId: "x1",
            detail: "ls",
            command: "ls -la",
          },
        },
        {
          type: "agent.tool.completed",
          payload: {
            name: "shell",
            executionId: "x1",
            outcome: "succeeded",
            durationMs: 40,
            exitCode: null,
            preview: "early output",
          },
        },
        {
          type: "agent.tool.called",
          payload: { name: "web_search", executionId: "x2", detail: "weather", input: '{"q":1}' },
        },
        {
          type: "computer.command",
          payload: {
            state: "tool-shell-finished",
            executionId: "x1",
            kind: "shell",
            command: "ls -la",
            cwd: ".",
            status: "done",
            exitCode: 4,
            output: "final output",
          },
        },
      ];
      for (const [index, event] of events.entries()) {
        await prisma.event.create({
          data: { spaceId, threadId, botId, runId, seq: index + 1, ...event },
        });
      }
    }),
  );

  afterAll(async () => {
    await db?.prisma.organization.deleteMany({ where: { id: organizationId } });
    await db?.prisma.user.deleteMany({ where: { id: userId } });
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("reads sealed tool events open, for a step's record and for the live snapshot", () =>
    system(async () => {
      // Stored sealed: a raw read sees no call id, which is why the reads go through the client.
      const raw = await db.prisma.$queryRaw<Array<{ id: string | null }>>`
        SELECT payload->>'executionId' AS id FROM events WHERE "threadId" = ${threadId}`;
      expect(raw.map((row) => row.id)).toEqual([null, null, null, null]);

      await expect(loadToolCallRecords(db.prisma, threadId, runId)).resolves.toEqual([
        {
          executionId: "x1",
          name: "shell",
          status: "done",
          outcome: "error",
          durationMs: 40,
          command: "ls -la",
          exitCode: 4,
          output: "final output",
        },
        { executionId: "x2", name: "web_search", status: "running", input: '{"q":1}' },
      ]);

      const live = await loadLiveRunEvents(db.prisma, threadId, [{ id: runId }]);
      expect(live.map((event) => event.payload)).toEqual([
        { name: "shell", executionId: "x1", detail: "ls", command: "ls -la" },
        { name: "shell", executionId: "x1", outcome: "succeeded", durationMs: 40, exitCode: null },
        { name: "web_search", executionId: "x2" },
      ]);
    }));
});
