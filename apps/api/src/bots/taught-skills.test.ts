import { runContinueJob } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, expect, it, vi } from "vitest";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService } from "./taught-skills.js";

afterEach(() => {
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

it("starts a skill test run even when waking it fails", async () => {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: false,
  };
  const runs: Array<Record<string, unknown>> = [];
  const prisma = {
    taughtSkill: {
      findFirst: vi.fn(async () => ({
        id: "skill-1",
        botId: "bot-1",
        status: "saved",
        name: "File expenses",
        goal: "File expenses",
        playbook: null,
      })),
    },
    bot: { findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    run: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        runs.push(data);
        return { id: "run-1" };
      }),
    },
  };
  const enqueue = vi.fn(async () => {
    throw new Error("queue unavailable");
  });
  const skills = createTaughtSkillsService({
    prisma,
    jobs: { enqueue },
  } as unknown as TaughtSkillsDeps);

  await expect(skills.testRun(actor, "skill-1")).resolves.toEqual({ runId: "run-1" });

  expect(runs).toEqual([
    expect.objectContaining({ taskId: "task-1", status: "queued", trigger: "skill" }),
  ]);
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("run-1"));
  expect(sink.events).toEqual([
    expect.objectContaining({ level: "error", message: "run wake failed", "run.id": "run-1" }),
  ]);
});
