import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEvent,
  asSystem,
  createDb,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRunExecutor } from "./executor.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

describePostgres("routine tick prompt and model consistency (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-prompt-${randomUUID()}@rakazo.test`;
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("routine prompt fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const { userId, spaceId, botId, threadId } = provisioned;
    identity = { userId, spaceId, botId, threadId };
  });
  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("runs the prompt that was saved with the model it claims", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "report",
        prompt: "OLD recipient",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: dueAt,
        modelProvider: "prov-a",
        modelId: "model-A",
      },
    });
    // The editor changes the prompt and the model but leaves nextRunAt alone,
    // so the tick's claim still matches; it must not pair the old prompt with
    // the new model. The edit lands right before the claim, after the tick
    // has already read the routine.
    const realTransaction = system.$transaction.bind(system);
    let editBeforeClaim: (() => Promise<unknown>) | null = async () => {
      await system.routine.update({
        where: { id: routine.id },
        data: { prompt: "CORRECTED recipient", modelProvider: "prov-b", modelId: "model-B" },
      });
    };
    const hooked = Object.create(system) as PrismaClient;
    hooked.$transaction = ((
      fn: Parameters<typeof realTransaction>[0],
      options?: Parameters<typeof realTransaction>[1],
    ) => {
      const edit = editBeforeClaim;
      editBeforeClaim = null;
      return (edit ? edit() : Promise.resolve()).then(() => realTransaction(fn, options));
    }) as PrismaClient["$transaction"];
    const executor = createRunExecutor({
      prisma: hooked,
      jobs: {
        enqueue: async () => undefined,
        cancel: async () => undefined,
        close: async () => undefined,
      },
      events: {
        append: (input: Parameters<typeof appendEvent>[1]) => appendEvent(system, input),
        notify: async () => undefined,
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine(routine.id, dueAt.toISOString());

    const run = await system.run.findFirstOrThrow({ where: { routineId: routine.id } });
    const task = await system.task.findUniqueOrThrow({ where: { id: run.taskId } });
    expect(task.prompt).toContain("CORRECTED");
    expect(run).toMatchObject({ modelProvider: "prov-b", modelId: "model-B", modelPinned: true });
  });
});
