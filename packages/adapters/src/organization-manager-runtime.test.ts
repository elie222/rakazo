import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationManagerRuntime } from "./organization-manager-runtime.js";

describe("OrganizationManagerRuntime", () => {
  it("creates a normal Rakazo manager task/run exactly once for a planning key", async () => {
    const tx = {
      managerEvaluation: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: "evaluation" })) },
      task: { create: vi.fn(async () => ({ id: "task" })) },
      run: { create: vi.fn(async () => ({ id: "run" })) },
      companyEvent: { create: vi.fn(async () => undefined) },
    };
    const prisma = {
      employeeProfile: {
        findFirst: vi.fn(async () => ({
          botId: "manager", role: "lead", mission: "Plan", responsibilities: [], authority: { canCreateWorkItems: true, canAssignWork: true }, department: { managerBotId: "manager", name: "Engineering" }, bot: { id: "manager", userId: "owner", thread: { id: "thread" } },
        })),
        findMany: vi.fn(async () => []),
      },
      project: { findFirst: vi.fn(async () => ({ id: "project", workspaceId: "workspace", ownerBotId: "manager", status: "active", name: "Landing", description: "", goal: null, workItems: [] })) },
      managerEvaluation: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;
    const runtime = createOrganizationManagerRuntime({ prisma, jobs });

    await expect(runtime.dispatch({ workspaceId: "workspace", managerBotId: "manager" })).resolves.toEqual({ runId: "run", created: true });
    expect(tx.run.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ trigger: "organization_manager", taskId: "task" }) }));
    expect(tx.managerEvaluation.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ runId: "run", projectId: "project" }) }));
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
  });

  it("applies a valid manager decision once and wakes the assigned employee", async () => {
    const evaluation = {
      id: "evaluation", workspaceId: "workspace", managerBotId: "manager", projectId: "project", planningKey: "key", status: "running",
      project: { id: "project", status: "planned", workItems: [] },
    };
    let finalized = false;
    const tx = {
      managerEvaluation: { updateMany: vi.fn(async () => ({ count: finalized ? 0 : (finalized = true, 1) })) },
      workItem: { create: vi.fn(async () => ({ id: "work" })) },
      companyEvent: { create: vi.fn(async () => undefined) },
      project: { update: vi.fn(async () => undefined) },
      escalation: { create: vi.fn(async () => ({ id: "escalation" })) },
      employeeProfile: { findFirst: vi.fn(async () => ({ reportsToBotId: null })) },
    };
    const manager = { botId: "manager", authority: { canCreateWorkItems: true, canAssignWork: true }, department: { managerBotId: "manager" } };
    const prisma = {
      managerEvaluation: { findUnique: vi.fn(async () => evaluation) },
      employeeProfile: { findFirst: vi.fn(async (query: { where?: { botId?: string } }) => query.where?.botId === "manager" ? manager : { botId: query.where?.botId, authority: query.where?.botId === "qa" ? { canReview: true } : {} }), },
      workItem: { count: vi.fn(async () => 0) },
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;
    const runtime = createOrganizationManagerRuntime({ prisma, jobs });
    const blocks = [{ kind: "text" as const, text: JSON.stringify({ summary: "Plan", actions: [{ type: "create_work_item", projectId: "project", title: "Implement landing page", description: "Build it", expectedOutcome: "Page", assignedToBotId: "developer", reviewerBotId: "qa", priority: "high" }] }) }];

    await expect(runtime.finalize({ runId: "run", outcome: "completed", blocks })).resolves.toBe(true);
    await expect(runtime.finalize({ runId: "run", outcome: "completed", blocks })).resolves.toBe(true);
    expect(tx.workItem.create).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "employee.wakeup", payload: expect.objectContaining({ botId: "developer" }) }));
  });

  it("schedules a bounded retry for malformed manager output without creating work", async () => {
    const evaluation = { id: "evaluation", workspaceId: "workspace", managerBotId: "manager", projectId: "project", planningKey: "key", attempt: 1, status: "running", project: { id: "project", status: "active", workItems: [] } };
    const prisma = {
      managerEvaluation: { findUnique: vi.fn(async () => evaluation), updateMany: vi.fn(async () => ({ count: 1 })) },
      companyEvent: { create: vi.fn(async () => undefined) },
    } as unknown as PrismaClient;
    const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;

    await expect(createOrganizationManagerRuntime({ prisma, jobs, retryBaseDelayMs: 0 }).finalize({ runId: "run", outcome: "completed", blocks: [{ kind: "text", text: "not json" }] })).resolves.toBe(true);
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "manager.evaluate", payload: expect.objectContaining({ managerBotId: "manager" }) }));
  });
});
