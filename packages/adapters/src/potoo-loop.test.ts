import { buildPotooRoutinePrompt, detectPotooFlight } from "@rakazo/potoo";
import { describe, expect, it } from "vitest";
import { escalatePatrolRun, maybeEscalatePatrolRun } from "./potoo-escalation.js";
import { createFakePotooJobs, createFakePotooPrisma } from "./potoo-loop.test-support.js";
import { maybeRepairCopy } from "./potoo-repair.js";
import { seedPotooRoutines } from "./potoo-seed.js";

const BLOODY =
  'lead\n```json\n{"findings": [{"title": "auth tokens expire early", "body": "broke", "evidence": ["auth.ts:41"], "confidence": "confirmed", "severity": "high"}], "back_page": [], "record": "front page"}\n```';
const QUIET =
  '```json\n{"findings": [], "back_page": [], "record": "quiet night: 212 passed, 0 failed"}\n```';

const CONTEXT = { spaceId: "space-1", botId: "bot-1", threadId: "thread-1", userId: "user-1" };

async function seedPatrol(prisma: any, finalText: string) {
  const task = await prisma.task.create({
    data: { ...CONTEXT, prompt: "patrol prompt", status: "queued" },
  });
  const run = await prisma.run.create({
    data: { ...CONTEXT, taskId: task.id, status: "completed", trigger: "routine" },
  });
  await prisma.message.create({
    data: {
      threadId: CONTEXT.threadId,
      seq: 1,
      role: "assistant",
      blocks: [{ kind: "text", text: finalText }],
      runId: run.id,
    },
  });
  await prisma.event.create({
    data: {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      seq: 1,
      type: "agent.tool.called",
      payload: { name: "shell_exec", executionId: "e1" },
      runId: run.id,
    },
  });
  await prisma.event.create({
    data: {
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      seq: 2,
      type: "agent.tool.completed",
      payload: { name: "shell_exec", outcome: "succeeded", durationMs: 42 },
      runId: run.id,
    },
  });
  return run;
}

describe("potoo night loop", () => {
  it("gates escalation: bloody enqueues, quiet and malformed do not", async () => {
    const prisma = createFakePotooPrisma();
    const fake = createFakePotooJobs();
    await maybeEscalatePatrolRun({ prisma, jobs: fake.jobs }, "run-1", BLOODY);
    expect(fake.enqueued).toHaveLength(1);
    expect(fake.enqueued[0]).toMatchObject({
      name: "potoo.escalate",
      payload: { patrolRunId: "run-1" },
    });
    await maybeEscalatePatrolRun({ prisma, jobs: fake.jobs }, "run-2", QUIET);
    await maybeEscalatePatrolRun({ prisma, jobs: fake.jobs }, "run-3", "prose without a block");
    expect(fake.enqueued).toHaveLength(1);
  });

  it("files one escalation with report plus transcript at 0.3", async () => {
    const prisma = createFakePotooPrisma();
    const fake = createFakePotooJobs();
    const patrol = await seedPatrol(prisma, BLOODY);
    await escalatePatrolRun({ prisma, jobs: fake.jobs }, patrol.id);
    const escalation = prisma._store.run.find(
      (row: any) => row.clientNonce === `potoo:escalation:${patrol.id}`,
    );
    expect(escalation).toBeDefined();
    expect(escalation.trigger).toBe("routine");
    const task = prisma._store.task.find((row: any) => row.id === escalation.taskId);
    expect(task.prompt).toContain("Reporter's filing:");
    expect(task.prompt).toContain("auth tokens expire early");
    expect(task.prompt).toContain("call shell_exec (e1)");
    expect(detectPotooFlight(task.prompt)?.temperature).toBe(0.3);
    expect(fake.enqueued).toMatchObject([{ name: "run.continue" }]);
    // Retry is a no-op: the paper files once.
    await escalatePatrolRun({ prisma, jobs: fake.jobs }, patrol.id);
    expect(prisma._store.run).toHaveLength(2);
    expect(fake.enqueued).toHaveLength(1);
  });

  it("repairs malformed copy once, never twice", async () => {
    const prisma = createFakePotooPrisma();
    const fake = createFakePotooJobs();
    const flight = detectPotooFlight(
      buildPotooRoutinePrompt("Beat.", {
        repo: "/home/potoo/repo",
        date: "2026-10-06",
        beatName: "bug-fix",
      }),
    )!;
    const run = { id: "run-9", ...CONTEXT };
    await maybeRepairCopy({ prisma, jobs: fake.jobs }, run, flight, "prose without a block");
    const repair = prisma._store.run.find((row: any) => row.clientNonce === "potoo:repair:run-9");
    expect(repair).toBeDefined();
    const task = prisma._store.task.find((row: any) => row.id === repair.taskId);
    expect(task.prompt).toContain("single fenced json block");
    expect(task.prompt).toContain("[potoo-repair: patrol]");
    expect(detectPotooFlight(task.prompt)?.temperature).toBe(0.2);
    // Second attempt for the same run is a no-op.
    await maybeRepairCopy({ prisma, jobs: fake.jobs }, run, flight, "still prose");
    expect(prisma._store.run).toHaveLength(1);
    // Valid copy never repairs.
    await maybeRepairCopy({ prisma, jobs: fake.jobs }, { id: "run-10", ...CONTEXT }, flight, QUIET);
    expect(prisma._store.run).toHaveLength(1);
  });

  it("seeds beats as routines, reseeds safely, rolls back on queue failure", async () => {
    const prisma = createFakePotooPrisma();
    const fake = createFakePotooJobs();
    const options = {
      ...CONTEXT,
      beats: [
        { name: "investigation", brief: "Read-only beat." },
        { name: "bug-fix", brief: "Reproduce-first beat." },
      ],
      repo: "/home/potoo/repo",
      date: "2026-10-06",
      cron: "0 2 * * *",
    };
    const first = await seedPotooRoutines({ prisma, jobs: fake.jobs }, options);
    expect(first.created).toEqual(["POTOO investigation", "POTOO bug-fix"]);
    expect(fake.enqueued).toHaveLength(2);
    const routine = prisma._store.routine[0];
    expect(routine.prompt).toContain("Tonight's assignment.");
    expect(detectPotooFlight(routine.prompt)?.temperature).toBe(0.2);
    const second = await seedPotooRoutines({ prisma, jobs: fake.jobs }, options);
    expect(second).toEqual({ created: [], skipped: ["POTOO investigation", "POTOO bug-fix"] });
    await expect(
      seedPotooRoutines({ prisma, jobs: fake.jobs }, { ...options, cron: "nope" }),
    ).rejects.toThrow();
    fake.failNext = true;
    await expect(
      seedPotooRoutines(
        { prisma, jobs: fake.jobs },
        { ...options, beats: [{ name: "fresh", brief: "New." }] },
      ),
    ).rejects.toThrow("queue unavailable");
    expect(prisma._store.routine.find((row: any) => row.name === "POTOO fresh")).toBeUndefined();
  });
});
