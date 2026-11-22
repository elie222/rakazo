import { randomUUID } from "node:crypto";
import { COMPUTER_START_FAILED_ERROR } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  pauseRoutineAfterRepeatedFailures,
  ROUTINE_FAILURE_PAUSE_AFTER,
} from "./routine-failure-pause.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

const TIMEOUT = "Request timed out.";

describePostgres("pausing a routine whose runs keep failing (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-failure-pause-${randomUUID()}@rakazo.test`;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const { userId, spaceId, botId, threadId } = await runAsSystem(
      "routine failure pause fixture",
      () => provisionMessagingIdentity(db.prisma, { provider: "email", address }),
    );
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

  async function fixture() {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "Every minute",
        prompt: "fixture",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: new Date(Date.now() + 60_000),
      },
    });
    const deps = {
      prisma: system,
      events: { notify: vi.fn(async () => undefined), publishSpaceChange: vi.fn() },
    };
    let at = Date.now() - 60 * 60_000;
    const record = async (status: "completed" | "failed" | "cancelled", error?: string) => {
      const task = await system.task.create({
        data: { ...identity, prompt: "fixture", status: "completed" },
      });
      at += 60_000;
      await system.run.create({
        data: {
          ...identity,
          routineId: routine.id,
          taskId: task.id,
          trigger: "routine",
          status,
          error: error ?? null,
          createdAt: new Date(at),
        },
      });
    };
    const fail = async (error = TIMEOUT) => {
      await record("failed", error);
      await pauseRoutineAfterRepeatedFailures(
        deps,
        { ...identity, routineId: routine.id },
        new Date(at),
      );
    };
    const read = () =>
      system.routine.findUniqueOrThrow({
        where: { id: routine.id },
        select: { active: true, nextRunAt: true },
      });
    const botMessages = () =>
      system.message.count({ where: { threadId: identity.threadId, role: "bot" } });
    const before = await botMessages();
    const pauseMessages = async () => (await botMessages()) - before;
    return { routine, deps, record, fail, read, pauseMessages };
  }

  it("pauses once after consecutive failures and says why", async () => {
    const { deps, fail, read, pauseMessages } = await fixture();
    for (let index = 1; index < ROUTINE_FAILURE_PAUSE_AFTER; index += 1) await fail();
    expect(await read()).toMatchObject({ active: true });

    await fail();
    expect(await read()).toEqual({ active: false, nextRunAt: null });
    expect(deps.events.publishSpaceChange).toHaveBeenCalledTimes(1);
    expect(await pauseMessages()).toBe(1);

    await fail();
    expect(await pauseMessages()).toBe(1);
  });

  it("starts over after a success", async () => {
    const { fail, record, read } = await fixture();
    for (let index = 1; index < ROUTINE_FAILURE_PAUSE_AFTER; index += 1) await fail();
    await record("completed");
    for (let index = 1; index < ROUTINE_FAILURE_PAUSE_AFTER; index += 1) await fail();
    expect(await read()).toMatchObject({ active: true });
    await fail();
    expect(await read()).toMatchObject({ active: false });
  });

  it("skips cancelled runs and does not count failures of the deployment", async () => {
    const { fail, record, read } = await fixture();
    for (let index = 1; index < ROUTINE_FAILURE_PAUSE_AFTER; index += 1) {
      await fail();
      await record("cancelled");
    }
    await record("failed", COMPUTER_START_FAILED_ERROR);
    await fail();
    expect(await read()).toMatchObject({ active: true });
  });

  it("does not count a different failure toward the streak", async () => {
    const { fail, record, read } = await fixture();
    for (let index = 1; index < ROUTINE_FAILURE_PAUSE_AFTER; index += 1) {
      await record("failed", "TypeError: Cannot read properties of undefined");
    }
    await fail();
    expect(await read()).toMatchObject({ active: true });
  });

  it("counts a fresh streak once the routine is turned back on", async () => {
    const { routine, fail, read, pauseMessages } = await fixture();
    for (let index = 0; index < ROUTINE_FAILURE_PAUSE_AFTER; index += 1) await fail();
    expect(await read()).toMatchObject({ active: false });

    await system.routine.update({ where: { id: routine.id }, data: { active: true } });
    for (let index = 1; index < ROUTINE_FAILURE_PAUSE_AFTER; index += 1) await fail();
    expect(await read()).toMatchObject({ active: true });
    await fail();
    expect(await read()).toMatchObject({ active: false });
    expect(await pauseMessages()).toBe(2);
  });
});
