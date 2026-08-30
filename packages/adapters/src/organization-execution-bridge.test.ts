import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationExecutionBridge } from "./organization-execution-bridge.js";

describe("OrganizationExecutionBridge", () => {
  it("creates a normal Rakazo task/run and durable work-item execution", async () => {
    const tx = {
      workItem: {
        findFirst: vi.fn(async () => ({ status: "assigned", assignedToBotId: "dev" })),
        update: vi.fn(),
      },
      workItemExecution: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "execution" })),
      },
      task: { create: vi.fn(async () => ({ id: "task" })) },
      run: { create: vi.fn(async () => ({ id: "run" })) },
      companyEvent: { create: vi.fn(async () => undefined) },
    };
    const prisma = {
      workItem: {
        findFirst: vi.fn(async () => ({
          id: "work",
          workspaceId: "workspace",
          assignedToBotId: "dev",
          status: "assigned",
          title: "Implement landing page",
          description: "Build it.",
          expectedOutcome: "A working page",
          projectId: "project",
          project: { name: "Landing Page V1", goal: { title: "Launch landing page" } },
        })),
      },
      workItemExecution: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
      bot: {
        findFirst: vi.fn(async () => ({
          id: "dev",
          userId: "owner",
          thread: { id: "thread" },
          employeeProfile: {
            role: "developer",
            mission: "Ship",
            responsibilities: [],
            authority: {},
          },
        })),
      },
      $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;

    const result = await createOrganizationExecutionBridge({ prisma, jobs }).dispatch({
      workspaceId: "workspace",
      workItemId: "work",
    });

    expect(result).toEqual({ runId: "run", created: true });
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "dev", threadId: "thread" }),
      }),
    );
    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "organization", taskId: "task" }),
      }),
    );
    expect(tx.workItemExecution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workItemId: "work", runId: "run", attempt: 1 }),
      }),
    );
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });

  it("settles a successful unreviewed execution exactly once", async () => {
    const prisma = {
      workItemExecution: {
        findUnique: vi.fn(async () => ({
          id: "execution",
          workspaceId: "workspace",
          workItemId: "work",
          attempt: 1,
          workItem: { reviewerBotId: null, assignedToBotId: "dev" },
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      workItem: { updateMany: vi.fn(async () => ({ count: 1 })) },
      companyEvent: { create: vi.fn(async () => undefined) },
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;

    await expect(
      createOrganizationExecutionBridge({ prisma, jobs }).finalize({
        runId: "run",
        outcome: "completed",
        blocks: [{ kind: "text", text: "done" }],
      }),
    ).resolves.toBe(true);
    expect(prisma.workItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "completed" } }),
    );
  });

  it("fences duplicate reviewer finalization before emitting follow-up work", async () => {
    const tx = {
      workItemReview: {
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
        update: vi.fn(async () => undefined),
      },
      workItem: { update: vi.fn(async () => undefined) },
      companyEvent: { create: vi.fn(async () => undefined) },
    };
    const prisma = {
      workItemExecution: { findUnique: vi.fn(async () => null) },
      workItemReview: {
        findFirst: vi.fn(async () => ({
          id: "review",
          workspaceId: "workspace",
          workItemId: "work",
          reviewerBotId: "qa",
          workItem: { assignedToBotId: "dev", projectId: "project" },
        })),
      },
      $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;
    const bridge = createOrganizationExecutionBridge({ prisma, jobs });
    const blocks = [
      {
        kind: "text" as const,
        text: JSON.stringify({
          decision: "changes_requested",
          summary: "Needs a fix",
          feedback: "Fix layout",
          evidence: [],
        }),
      },
    ];

    await expect(
      bridge.finalize({ runId: "review-run", outcome: "completed", blocks }),
    ).resolves.toBe(true);
    await expect(
      bridge.finalize({ runId: "review-run", outcome: "completed", blocks }),
    ).resolves.toBe(false);
    expect(tx.companyEvent.create).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
  });
});
