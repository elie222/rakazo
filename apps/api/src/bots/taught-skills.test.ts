import { runContinueJob } from "@rakazo/adapter-kit";
import { IsolationError } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, expect, it, vi } from "vitest";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService } from "./taught-skills.js";

afterEach(() => {
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

it("refuses a skill test run on an archived bot without creating a task or run", async () => {
  const savedSkill = {
    id: "skill-1",
    botId: "bot-1",
    status: "saved",
    name: "File expenses",
    goal: "File expenses",
    playbook: null,
  };
  const task = vi.fn(async () => ({ id: "task-1" }));
  const run = vi.fn(async () => ({ id: "run-1" }));
  const enqueue = vi.fn();
  const prisma = {
    taughtSkill: { findFirst: vi.fn(async () => savedSkill) },
    bot: {
      findUnique: vi.fn(async () => ({
        id: "bot-1",
        thread: { id: "thread-1" },
        archivedAt: new Date(),
      })),
    },
    task: { create: task },
    run: { create: run },
  };
  const skills = createTaughtSkillsService({
    prisma,
    jobs: { enqueue },
  } as unknown as TaughtSkillsDeps);

  await expect(skills.testRun(actor, "skill-1")).rejects.toThrow(IsolationError);

  expect(task).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});

it("refuses to start a teaching session on an archived bot before touching its computer", async () => {
  const prisma = {
    bot: {
      findFirst: vi.fn(async () => ({
        id: "bot-1",
        spaceId: "space-1",
        thread: { id: "thread-1" },
        computer: { id: "computer-1" },
        archivedAt: new Date(),
      })),
    },
  };
  const skills = createTaughtSkillsService({ prisma } as unknown as TaughtSkillsDeps);

  await expect(skills.start(actor, "bot-1", "File expenses")).rejects.toThrow(IsolationError);
});

it("starts a skill test run even when waking it fails", async () => {
  const sink = createTestSink();
  installLogger(createLogger({ service: "test", sinks: [sink] }));
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

it("treats a blank or whitespace-only skill name as no name", async () => {
  const draft = {
    id: "skill-1",
    botId: "bot-1",
    userId: "user-1",
    status: "draft",
    name: "",
    goal: "  File expenses  ",
    playbook: null,
    recording: null,
    startedAt: null,
    expiresAt: null,
    stoppedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let skill = draft;
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    skill = { ...skill, ...data };
    return skill;
  });
  const prisma = {
    taughtSkill: { findFirst: vi.fn(async () => skill), update },
    // No bot thread, so there is no draft card or saved event to update.
    bot: { findUnique: vi.fn(async () => null) },
  };
  const skills = createTaughtSkillsService({ prisma } as unknown as TaughtSkillsDeps);

  await expect(skills.save(actor, "skill-1", "   ")).resolves.toMatchObject({
    name: "File expenses",
  });
  await expect(skills.save(actor, "skill-1", "")).resolves.toMatchObject({
    name: "File expenses",
  });
  const playbook = {
    whenToUse: "",
    inputs: [],
    steps: [],
    howToCheck: "",
    whatToReturn: "",
    approvalBoundaries: "",
    failureHandling: "",
  };
  await expect(
    skills.updateDraft(actor, "skill-1", { name: " \t", playbook }),
  ).resolves.toMatchObject({ name: "File expenses" });
  await expect(skills.save(actor, "skill-1", "  Expense report  ")).resolves.toMatchObject({
    name: "Expense report",
  });
  expect(skill.name).toBe("Expense report");
});
