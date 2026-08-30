import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import {
  assertGoalTransition,
  assertProjectTransition,
  assertWorkItemTransition,
  buildWorkItemIdempotencyKey,
  validateSopDefinition,
  wouldCreateCycle,
} from "@rakazo/organization";

// ── Mappers ──
function toIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}
function deptRow(row: {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  parentDepartmentId: string | null;
  managerBotId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    parentDepartmentId: row.parentDepartmentId,
    managerBotId: row.managerBotId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function employeeRow(row: {
  id: string;
  workspaceId: string;
  botId: string;
  departmentId: string | null;
  reportsToBotId: string | null;
  role: string;
  mission: string;
  responsibilities: unknown;
  authority: unknown;
  autonomyLevel: string;
  workMode: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  runtime?: {
    status: string;
    currentWorkItemId: string | null;
    lastActiveAt: Date | null;
    lastEvaluationAt: Date | null;
    nextWakeAt: Date | null;
    failureCount: number;
  } | null;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    botId: row.botId,
    departmentId: row.departmentId,
    reportsToBotId: row.reportsToBotId,
    role: row.role,
    mission: row.mission,
    responsibilities: (row.responsibilities as string[]) ?? [],
    authority: (row.authority as Record<string, boolean>) ?? {},
    autonomyLevel: row.autonomyLevel as "supervised" | "standard" | "autonomous",
    workMode: row.workMode as "supervised" | "standard" | "autonomous",
    status: row.status as never,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    runtime: row.runtime
      ? {
          status: row.runtime.status as never,
          currentWorkItemId: row.runtime.currentWorkItemId,
          lastActiveAt: toIso(row.runtime.lastActiveAt),
          lastEvaluationAt: toIso(row.runtime.lastEvaluationAt),
          nextWakeAt: toIso(row.runtime.nextWakeAt),
          failureCount: row.runtime.failureCount,
        }
      : null,
  };
}

// ── Departments ──
export async function listDepartments(prisma: PrismaClient, actor: Actor) {
  const rows = await prisma.department.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(deptRow);
}
export async function getDepartment(prisma: PrismaClient, actor: Actor, departmentId: string) {
  const row = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId: actor.workspaceId },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Department not found" });
  return deptRow(row);
}
export async function createDepartment(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    name: string;
    description?: string;
    parentDepartmentId?: string | null;
    managerBotId?: string | null;
  },
) {
  if (input.parentDepartmentId) {
    const parent = await prisma.department.findFirst({
      where: { id: input.parentDepartmentId, workspaceId: actor.workspaceId },
    });
    if (!parent) throw new ORPCError("BAD_REQUEST", { message: "Parent department not found" });
  }
  if (input.managerBotId) {
    const bot = await prisma.bot.findFirst({
      where: { id: input.managerBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!bot) throw new IsolationError();
  }
  const row = await prisma.department.create({
    data: {
      workspaceId: actor.workspaceId,
      name: input.name.trim(),
      description: input.description ?? "",
      parentDepartmentId: input.parentDepartmentId ?? null,
      managerBotId: input.managerBotId ?? null,
    },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "department.created",
      payload: { departmentId: row.id } as never,
    },
  });
  return deptRow(row);
}
export async function updateDepartment(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    departmentId: string;
    name?: string;
    description?: string;
    parentDepartmentId?: string | null;
    managerBotId?: string | null;
  },
) {
  const existing = await prisma.department.findFirst({
    where: { id: input.departmentId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Department not found" });
  if (input.parentDepartmentId !== undefined) {
    if (input.parentDepartmentId) {
      const parent = await prisma.department.findFirst({
        where: { id: input.parentDepartmentId, workspaceId: actor.workspaceId },
      });
      if (!parent) throw new ORPCError("BAD_REQUEST", { message: "Parent department not found" });
      const all = await prisma.department.findMany({
        where: { workspaceId: actor.workspaceId },
        select: { id: true, parentDepartmentId: true },
      });
      if (wouldCreateCycle(all, existing.id, input.parentDepartmentId)) {
        throw new ORPCError("BAD_REQUEST", { message: "Department cycle detected" });
      }
    }
  }
  if (input.managerBotId !== undefined && input.managerBotId) {
    const bot = await prisma.bot.findFirst({
      where: { id: input.managerBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!bot) throw new IsolationError();
  }
  const row = await prisma.department.update({
    where: { id: input.departmentId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.parentDepartmentId !== undefined
        ? { parentDepartmentId: input.parentDepartmentId }
        : {}),
      ...(input.managerBotId !== undefined ? { managerBotId: input.managerBotId } : {}),
    },
  });
  return deptRow(row);
}
export async function removeDepartment(prisma: PrismaClient, actor: Actor, departmentId: string) {
  const existing = await prisma.department.findFirst({
    where: { id: departmentId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Department not found" });
  const child = await prisma.department.findFirst({ where: { parentDepartmentId: departmentId } });
  if (child)
    throw new ORPCError("BAD_REQUEST", { message: "Cannot delete department with subdepartments" });
  await prisma.department.delete({ where: { id: departmentId } });
  return { ok: true as const };
}

// ── Employees ──
export async function listEmployees(prisma: PrismaClient, actor: Actor) {
  const rows = await prisma.employeeProfile.findMany({
    where: { workspaceId: actor.workspaceId },
    include: { runtime: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => employeeRow(r as never));
}
export async function getEmployee(prisma: PrismaClient, actor: Actor, botId: string) {
  const row = await prisma.employeeProfile.findFirst({
    where: { botId, workspaceId: actor.workspaceId },
    include: { runtime: true },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Employee not found" });
  return employeeRow(row as never);
}
export async function createEmployeeProfile(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    botId: string;
    departmentId?: string | null;
    reportsToBotId?: string | null;
    role?: string;
    mission?: string;
    responsibilities?: string[];
    authority?: Record<string, boolean>;
    autonomyLevel?: string;
    workMode?: string;
  },
) {
  const bot = await prisma.bot.findFirst({
    where: { id: input.botId, workspaceId: actor.workspaceId, userId: actor.userId },
  });
  if (!bot) throw new IsolationError();
  const existing = await prisma.employeeProfile.findUnique({ where: { botId: input.botId } });
  if (existing)
    throw new ORPCError("CONFLICT", { message: "Employee profile already exists for bot" });
  if (input.departmentId) {
    const dept = await prisma.department.findFirst({
      where: { id: input.departmentId, workspaceId: actor.workspaceId },
    });
    if (!dept) throw new ORPCError("BAD_REQUEST", { message: "Department not found" });
  }
  if (input.reportsToBotId) {
    const mgr = await prisma.bot.findFirst({
      where: { id: input.reportsToBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!mgr) throw new IsolationError();
    if (input.reportsToBotId === input.botId)
      throw new ORPCError("BAD_REQUEST", { message: "Cannot report to self" });
  }
  await prisma.employeeProfile.create({
    data: {
      workspaceId: actor.workspaceId,
      botId: input.botId,
      departmentId: input.departmentId ?? null,
      reportsToBotId: input.reportsToBotId ?? null,
      role: input.role ?? "employee",
      mission: input.mission ?? "",
      responsibilities: (input.responsibilities ?? []) as never,
      authority: (input.authority ?? {}) as never,
      autonomyLevel: input.autonomyLevel ?? "standard",
      workMode: input.workMode ?? "standard",
    },
    include: { runtime: true },
  });
  // create runtime state
  await prisma.employeeRuntimeState.create({
    data: {
      workspaceId: actor.workspaceId,
      botId: input.botId,
      status: "idle",
    },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "employee.created",
      actorBotId: input.botId,
      payload: {} as never,
    },
  });
  const withRuntime = await prisma.employeeProfile.findUnique({
    where: { botId: input.botId },
    include: { runtime: true },
  });
  return employeeRow(withRuntime as never);
}
export async function updateEmployeeProfile(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    botId: string;
    departmentId?: string | null;
    reportsToBotId?: string | null;
    role?: string;
    mission?: string;
    responsibilities?: string[];
    authority?: Record<string, boolean>;
    autonomyLevel?: string;
    workMode?: string;
    status?: string;
  },
) {
  const existing = await prisma.employeeProfile.findFirst({
    where: { botId: input.botId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Employee not found" });
  if (input.departmentId !== undefined && input.departmentId) {
    const dept = await prisma.department.findFirst({
      where: { id: input.departmentId, workspaceId: actor.workspaceId },
    });
    if (!dept) throw new ORPCError("BAD_REQUEST", { message: "Department not found" });
  }
  if (input.reportsToBotId !== undefined && input.reportsToBotId) {
    if (input.reportsToBotId === input.botId)
      throw new ORPCError("BAD_REQUEST", { message: "Cannot report to self" });
    const mgr = await prisma.bot.findFirst({
      where: { id: input.reportsToBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!mgr) throw new IsolationError();
  }
  const row = await prisma.employeeProfile.update({
    where: { botId: input.botId },
    data: {
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.reportsToBotId !== undefined ? { reportsToBotId: input.reportsToBotId } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.mission !== undefined ? { mission: input.mission } : {}),
      ...(input.responsibilities !== undefined
        ? { responsibilities: input.responsibilities as never }
        : {}),
      ...(input.authority !== undefined ? { authority: input.authority as never } : {}),
      ...(input.autonomyLevel !== undefined ? { autonomyLevel: input.autonomyLevel } : {}),
      ...(input.workMode !== undefined ? { workMode: input.workMode } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
    include: { runtime: true },
  });
  return employeeRow(row as never);
}
export async function removeEmployee(prisma: PrismaClient, actor: Actor, botId: string) {
  const existing = await prisma.employeeProfile.findFirst({
    where: { botId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Employee not found" });
  // Prevent removing manager with reports or department manager
  const reports = await prisma.employeeProfile.findFirst({ where: { reportsToBotId: botId } });
  if (reports)
    throw new ORPCError("BAD_REQUEST", { message: "Cannot remove employee with direct reports" });
  await prisma.employeeRuntimeState.deleteMany({ where: { botId } });
  await prisma.employeeProfile.delete({ where: { botId } });
  return { ok: true as const };
}

// ── Goals ──
function goalRow(row: {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  ownerBotId: string | null;
  startsAt: Date | null;
  targetAt: Date | null;
  metrics: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    description: row.description,
    priority: row.priority as never,
    status: row.status as never,
    ownerBotId: row.ownerBotId,
    startsAt: toIso(row.startsAt),
    targetAt: toIso(row.targetAt),
    metrics: (row.metrics as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listGoals(prisma: PrismaClient, actor: Actor) {
  const rows = await prisma.companyGoal.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(goalRow);
}
export async function getGoal(prisma: PrismaClient, actor: Actor, goalId: string) {
  const row = await prisma.companyGoal.findFirst({
    where: { id: goalId, workspaceId: actor.workspaceId },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Goal not found" });
  return goalRow(row);
}
export async function createGoal(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    title: string;
    description?: string;
    priority?: string;
    ownerBotId?: string | null;
    startsAt?: string | null;
    targetAt?: string | null;
    metrics?: Record<string, unknown>;
  },
) {
  if (input.ownerBotId) {
    const bot = await prisma.bot.findFirst({
      where: { id: input.ownerBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!bot) throw new IsolationError();
  }
  const row = await prisma.companyGoal.create({
    data: {
      workspaceId: actor.workspaceId,
      title: input.title.trim(),
      description: input.description ?? "",
      priority: input.priority ?? "medium",
      status: "draft",
      ownerBotId: input.ownerBotId ?? null,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      targetAt: input.targetAt ? new Date(input.targetAt) : null,
      metrics: (input.metrics ?? {}) as never,
    },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "goal.created",
      goalId: row.id,
      actorBotId: input.ownerBotId ?? null,
      payload: {} as never,
    },
  });
  return goalRow(row);
}
export async function updateGoal(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    goalId: string;
    title?: string;
    description?: string;
    priority?: string;
    status?: string;
    ownerBotId?: string | null;
    startsAt?: string | null;
    targetAt?: string | null;
    metrics?: Record<string, unknown>;
  },
) {
  const existing = await prisma.companyGoal.findFirst({
    where: { id: input.goalId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Goal not found" });
  if (input.status && input.status !== existing.status) {
    assertGoalTransition(existing.status as never, input.status as never);
  }
  if (input.ownerBotId !== undefined && input.ownerBotId) {
    const bot = await prisma.bot.findFirst({
      where: { id: input.ownerBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!bot) throw new IsolationError();
  }
  const row = await prisma.companyGoal.update({
    where: { id: input.goalId },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.ownerBotId !== undefined ? { ownerBotId: input.ownerBotId } : {}),
      ...(input.startsAt !== undefined
        ? { startsAt: input.startsAt ? new Date(input.startsAt) : null }
        : {}),
      ...(input.targetAt !== undefined
        ? { targetAt: input.targetAt ? new Date(input.targetAt) : null }
        : {}),
      ...(input.metrics !== undefined ? { metrics: input.metrics as never } : {}),
    },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "goal.updated",
      goalId: row.id,
      payload: { status: row.status } as never,
    },
  });
  return goalRow(row);
}
export async function removeGoal(prisma: PrismaClient, actor: Actor, goalId: string) {
  const existing = await prisma.companyGoal.findFirst({
    where: { id: goalId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Goal not found" });
  await prisma.companyGoal.delete({ where: { id: goalId } });
  return { ok: true as const };
}

// ── Projects ──
function projectRow(row: {
  id: string;
  workspaceId: string;
  goalId: string | null;
  name: string;
  description: string;
  ownerBotId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    goalId: row.goalId,
    name: row.name,
    description: row.description,
    ownerBotId: row.ownerBotId,
    status: row.status as never,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listProjects(prisma: PrismaClient, actor: Actor) {
  const rows = await prisma.project.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(projectRow);
}
export async function getProject(prisma: PrismaClient, actor: Actor, projectId: string) {
  const row = await prisma.project.findFirst({
    where: { id: projectId, workspaceId: actor.workspaceId },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Project not found" });
  return projectRow(row);
}
export async function createProject(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    name: string;
    description?: string;
    goalId?: string | null;
    ownerBotId?: string | null;
    status?: string;
  },
) {
  if (input.goalId) {
    const goal = await prisma.companyGoal.findFirst({
      where: { id: input.goalId, workspaceId: actor.workspaceId },
    });
    if (!goal) throw new ORPCError("BAD_REQUEST", { message: "Goal not found" });
  }
  if (input.ownerBotId) {
    const bot = await prisma.bot.findFirst({
      where: { id: input.ownerBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!bot) throw new IsolationError();
  }
  const row = await prisma.project.create({
    data: {
      workspaceId: actor.workspaceId,
      name: input.name.trim(),
      description: input.description ?? "",
      goalId: input.goalId ?? null,
      ownerBotId: input.ownerBotId ?? null,
      status: input.status ?? "planned",
    },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "project.created",
      projectId: row.id,
      payload: {} as never,
    },
  });
  return projectRow(row);
}
export async function updateProject(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    projectId: string;
    name?: string;
    description?: string;
    goalId?: string | null;
    ownerBotId?: string | null;
    status?: string;
  },
) {
  const existing = await prisma.project.findFirst({
    where: { id: input.projectId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Project not found" });
  if (input.status && input.status !== existing.status)
    assertProjectTransition(existing.status as never, input.status as never);
  if (input.goalId !== undefined && input.goalId) {
    const goal = await prisma.companyGoal.findFirst({
      where: { id: input.goalId, workspaceId: actor.workspaceId },
    });
    if (!goal) throw new ORPCError("BAD_REQUEST", { message: "Goal not found" });
  }
  const row = await prisma.project.update({
    where: { id: input.projectId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
      ...(input.ownerBotId !== undefined ? { ownerBotId: input.ownerBotId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });
  return projectRow(row);
}
export async function removeProject(prisma: PrismaClient, actor: Actor, projectId: string) {
  const existing = await prisma.project.findFirst({
    where: { id: projectId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Project not found" });
  await prisma.project.delete({ where: { id: projectId } });
  return { ok: true as const };
}

// ── WorkItems ──
function workItemRow(row: {
  id: string;
  workspaceId: string;
  projectId: string | null;
  parentWorkItemId: string | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  createdByBotId: string | null;
  assignedToBotId: string | null;
  reviewerBotId: string | null;
  source: string;
  expectedOutcome: string;
  required: boolean;
  dueAt: Date | null;
  idempotencyKey: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    parentWorkItemId: row.parentWorkItemId,
    title: row.title,
    description: row.description,
    status: row.status as never,
    priority: row.priority as never,
    createdByBotId: row.createdByBotId,
    assignedToBotId: row.assignedToBotId,
    reviewerBotId: row.reviewerBotId,
    source: row.source as never,
    expectedOutcome: row.expectedOutcome,
    required: row.required,
    dueAt: toIso(row.dueAt),
    idempotencyKey: row.idempotencyKey,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listWorkItems(
  prisma: PrismaClient,
  actor: Actor,
  filter: { projectId?: string; assignedToBotId?: string; status?: string },
) {
  const rows = await prisma.workItem.findMany({
    where: {
      workspaceId: actor.workspaceId,
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.assignedToBotId ? { assignedToBotId: filter.assignedToBotId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map(workItemRow);
}
export async function getWorkItem(prisma: PrismaClient, actor: Actor, workItemId: string) {
  const row = await prisma.workItem.findFirst({
    where: { id: workItemId, workspaceId: actor.workspaceId },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "WorkItem not found" });
  return workItemRow(row);
}
export async function createWorkItem(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    title: string;
    description?: string;
    projectId?: string | null;
    parentWorkItemId?: string | null;
    priority?: string;
    assignedToBotId?: string | null;
    reviewerBotId?: string | null;
    source?: string;
    expectedOutcome?: string;
    required?: boolean;
    dueAt?: string | null;
    idempotencyKey?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  if (input.projectId) {
    const proj = await prisma.project.findFirst({
      where: { id: input.projectId, workspaceId: actor.workspaceId },
    });
    if (!proj) throw new ORPCError("BAD_REQUEST", { message: "Project not found" });
  }
  if (input.parentWorkItemId) {
    const parent = await prisma.workItem.findFirst({
      where: { id: input.parentWorkItemId, workspaceId: actor.workspaceId },
    });
    if (!parent) throw new ORPCError("BAD_REQUEST", { message: "Parent WorkItem not found" });
  }
  if (input.assignedToBotId) {
    const bot = await prisma.bot.findFirst({
      where: { id: input.assignedToBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!bot) throw new IsolationError();
  }
  if (input.reviewerBotId) {
    const reviewer = await prisma.bot.findFirst({
      where: { id: input.reviewerBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!reviewer) throw new IsolationError();
  }
  // Deterministic duplicate detection: if idempotencyKey provided, check existing
  const key =
    input.idempotencyKey ??
    buildWorkItemIdempotencyKey({
      workspaceId: actor.workspaceId,
      projectId: input.projectId ?? null,
      parentWorkItemId: input.parentWorkItemId ?? null,
      title: input.title,
      source: input.source ?? "manual",
    });
  const duplicate = await prisma.workItem.findUnique({ where: { idempotencyKey: key } });
  if (duplicate && duplicate.workspaceId === actor.workspaceId) {
    return workItemRow(duplicate);
  }
  if (duplicate) {
    // The key is unique globally. A caller must never be able to turn a
    // collision with another workspace into a successful write or a data leak.
    throw new ORPCError("CONFLICT", { message: "Work item idempotency key already exists" });
  }
  // Also check duplicate title in same project/parent
  const sameTitle = await prisma.workItem.findFirst({
    where: {
      workspaceId: actor.workspaceId,
      projectId: input.projectId ?? null,
      parentWorkItemId: input.parentWorkItemId ?? null,
      title: { equals: input.title.trim(), mode: "insensitive" },
      status: { notIn: ["completed", "cancelled", "failed"] },
    },
  });
  if (sameTitle)
    throw new ORPCError("CONFLICT", { message: "Duplicate work item title in same context" });

  const row = await prisma.workItem.create({
    data: {
      workspaceId: actor.workspaceId,
      title: input.title.trim(),
      description: input.description ?? "",
      projectId: input.projectId ?? null,
      parentWorkItemId: input.parentWorkItemId ?? null,
      priority: input.priority ?? "medium",
      status: input.assignedToBotId ? "assigned" : "backlog",
      createdByBotId: null,
      assignedToBotId: input.assignedToBotId ?? null,
      reviewerBotId: input.reviewerBotId ?? null,
      source: input.source ?? "manual",
      expectedOutcome: input.expectedOutcome ?? "",
      required: input.required ?? true,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      idempotencyKey: key,
      metadata: (input.metadata ?? {}) as never,
    },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "work.created",
      workItemId: row.id,
      projectId: row.projectId,
      payload: { title: row.title } as never,
    },
  });
  return workItemRow(row);
}
export async function updateWorkItem(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    workItemId: string;
    title?: string;
    description?: string;
    priority?: string;
    status?: string;
    assignedToBotId?: string | null;
    reviewerBotId?: string | null;
    dueAt?: string | null;
    expectedOutcome?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const existing = await prisma.workItem.findFirst({
    where: { id: input.workItemId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "WorkItem not found" });
  // Status changes are a domain operation, not a generic patch. Keeping this
  // boundary prevents callers from accidentally bypassing review/approval
  // invariants or omitting the corresponding activity event.
  if (input.status !== undefined) {
    throw new ORPCError("BAD_REQUEST", { message: "Use workItems.transition to change status" });
  }
  if (input.assignedToBotId !== undefined && input.assignedToBotId) {
    const bot = await prisma.bot.findFirst({
      where: { id: input.assignedToBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!bot) throw new IsolationError();
  }
  const row = await prisma.workItem.update({
    where: { id: input.workItemId },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.assignedToBotId !== undefined ? { assignedToBotId: input.assignedToBotId } : {}),
      ...(input.reviewerBotId !== undefined ? { reviewerBotId: input.reviewerBotId } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt ? new Date(input.dueAt) : null } : {}),
      ...(input.expectedOutcome !== undefined ? { expectedOutcome: input.expectedOutcome } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata as never } : {}),
    },
  });
  return workItemRow(row);
}
export async function transitionWorkItem(
  prisma: PrismaClient,
  actor: Actor,
  input: { workItemId: string; toStatus: string; reason?: string },
) {
  const existing = await prisma.workItem.findFirst({
    where: { id: input.workItemId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "WorkItem not found" });
  assertWorkItemTransition(existing.status as never, input.toStatus as never);
  if (input.toStatus === "completed" && existing.reviewerBotId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "WorkItem with a reviewer must be completed through review",
    });
  }
  if (input.toStatus === "waiting_review" && !existing.reviewerBotId) {
    throw new ORPCError("BAD_REQUEST", { message: "Assign a reviewer before requesting review" });
  }
  const row = await prisma.workItem.update({
    where: { id: input.workItemId },
    data: { status: input.toStatus },
  });
  const eventType =
    input.toStatus === "completed"
      ? "work.completed"
      : input.toStatus === "failed"
        ? "work.failed"
        : input.toStatus === "blocked"
          ? "work.blocked"
          : input.toStatus === "in_progress"
            ? "work.started"
            : "work.updated";
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: eventType,
      workItemId: row.id,
      payload: { from: existing.status, to: input.toStatus, reason: input.reason } as never,
    },
  });
  // If completed and has parent, maybe check parent completion? Not auto.
  if (input.toStatus === "completed" && row.projectId) {
    // do not auto-complete project
  }
  return workItemRow(row);
}
export async function assignWorkItem(
  prisma: PrismaClient,
  actor: Actor,
  input: { workItemId: string; assignedToBotId: string | null; reviewerBotId?: string | null },
) {
  const existing = await prisma.workItem.findFirst({
    where: { id: input.workItemId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "WorkItem not found" });
  if (input.assignedToBotId) {
    const bot = await prisma.bot.findFirst({
      where: { id: input.assignedToBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!bot) throw new IsolationError();
  }
  const nextStatus = input.assignedToBotId ? "assigned" : "ready";
  // Validate transition from current to assigned/ready if needed
  try {
    assertWorkItemTransition(existing.status as never, nextStatus as never);
  } catch {
    // allow assignment without strict status if already assigned? Keep idempotent
    if (existing.status === "assigned" && nextStatus === "assigned") {
      // ok
    } else if (existing.status === nextStatus) {
      // ok
    } else {
      throw new ORPCError("BAD_REQUEST", {
        message: `Cannot assign from status ${existing.status}`,
      });
    }
  }
  const row = await prisma.workItem.update({
    where: { id: input.workItemId },
    data: {
      assignedToBotId: input.assignedToBotId,
      ...(input.reviewerBotId !== undefined ? { reviewerBotId: input.reviewerBotId } : {}),
      status:
        existing.status === "backlog" || existing.status === "ready" ? nextStatus : existing.status,
    },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "work.assigned",
      workItemId: row.id,
      payload: { assignedToBotId: input.assignedToBotId } as never,
    },
  });
  return workItemRow(row);
}
export async function delegateWorkItem(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    workItemId: string;
    title: string;
    description?: string;
    assignedToBotId: string;
    expectedOutcome?: string;
  },
) {
  const parent = await prisma.workItem.findFirst({
    where: { id: input.workItemId, workspaceId: actor.workspaceId },
  });
  if (!parent) throw new ORPCError("NOT_FOUND", { message: "Parent WorkItem not found" });
  const bot = await prisma.bot.findFirst({
    where: { id: input.assignedToBotId, workspaceId: actor.workspaceId, userId: actor.userId },
  });
  if (!bot) throw new IsolationError();
  // Check authority: if parent assigned, require canDelegate
  if (parent.assignedToBotId) {
    const profile = await prisma.employeeProfile.findUnique({
      where: { botId: parent.assignedToBotId },
    });
    const authority = (profile?.authority as Record<string, boolean>) ?? {};
    if (!authority.canDelegate && !authority.canAssignWork) {
      // allow if manager role
      if (profile?.role !== "manager" && profile?.role !== "executive" && profile?.role !== "ceo") {
        throw new ORPCError("FORBIDDEN", { message: "Not authorized to delegate" });
      }
    }
  }
  const child = await prisma.workItem.create({
    data: {
      workspaceId: actor.workspaceId,
      title: input.title.trim(),
      description: input.description ?? "",
      projectId: parent.projectId,
      parentWorkItemId: parent.id,
      priority: parent.priority,
      status: "assigned",
      assignedToBotId: input.assignedToBotId,
      source: "delegation",
      expectedOutcome: input.expectedOutcome ?? "",
      idempotencyKey: buildWorkItemIdempotencyKey({
        workspaceId: actor.workspaceId,
        projectId: parent.projectId ?? undefined,
        parentWorkItemId: parent.id,
        title: input.title,
        source: "delegation",
      }),
      metadata: { parentWorkItemId: parent.id } as never,
    },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "work.created",
      workItemId: child.id,
      payload: { delegatedFrom: parent.id } as never,
    },
  });
  return workItemRow(child);
}

// ── Reviews ──
function reviewRow(row: {
  id: string;
  workspaceId: string;
  workItemId: string;
  reviewerBotId: string | null;
  status: string;
  summary: string;
  feedback: string;
  createdAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workItemId: row.workItemId,
    reviewerBotId: row.reviewerBotId,
    status: row.status as never,
    summary: row.summary,
    feedback: row.feedback,
    createdAt: row.createdAt.toISOString(),
    completedAt: toIso(row.completedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listReviews(prisma: PrismaClient, actor: Actor, workItemId: string) {
  const wi = await prisma.workItem.findFirst({
    where: { id: workItemId, workspaceId: actor.workspaceId },
  });
  if (!wi) throw new ORPCError("NOT_FOUND", { message: "WorkItem not found" });
  const rows = await prisma.workItemReview.findMany({
    where: { workspaceId: actor.workspaceId, workItemId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(reviewRow);
}
export async function createReview(
  prisma: PrismaClient,
  actor: Actor,
  input: { workItemId: string; reviewerBotId?: string | null; summary?: string },
) {
  const wi = await prisma.workItem.findFirst({
    where: { id: input.workItemId, workspaceId: actor.workspaceId },
  });
  if (!wi) throw new ORPCError("NOT_FOUND", { message: "WorkItem not found" });
  if (input.reviewerBotId) {
    const bot = await prisma.bot.findFirst({
      where: { id: input.reviewerBotId, workspaceId: actor.workspaceId, userId: actor.userId },
    });
    if (!bot) throw new IsolationError();
  }
  const reviewerBotId = input.reviewerBotId ?? wi.reviewerBotId ?? null;
  if (!reviewerBotId) throw new ORPCError("BAD_REQUEST", { message: "Reviewer is required" });
  assertWorkItemTransition(wi.status as never, "waiting_review");
  const pending = await prisma.workItemReview.findFirst({
    where: { workspaceId: actor.workspaceId, workItemId: wi.id, status: "pending" },
  });
  if (pending)
    throw new ORPCError("CONFLICT", { message: "WorkItem already has a pending review" });
  const [row] = await prisma.$transaction([
    prisma.workItemReview.create({
      data: {
        workspaceId: actor.workspaceId,
        workItemId: input.workItemId,
        reviewerBotId,
        status: "pending",
        summary: input.summary ?? "",
      },
    }),
    prisma.workItem.update({
      where: { id: wi.id },
      data: { status: "waiting_review", reviewerBotId },
    }),
  ]);
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "review.requested",
      workItemId: wi.id,
      payload: { reviewId: row.id } as never,
    },
  });
  return reviewRow(row);
}
export async function completeReview(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    reviewId: string;
    status: "approved" | "changes_requested" | "cancelled";
    summary?: string;
    feedback?: string;
  },
) {
  const existing = await prisma.workItemReview.findFirst({
    where: { id: input.reviewId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Review not found" });
  if (existing.status !== "pending")
    throw new ORPCError("CONFLICT", { message: "Review has already been completed" });
  const row = await prisma.workItemReview.update({
    where: { id: input.reviewId },
    data: {
      status: input.status,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
      completedAt: new Date(),
    },
  });
  // Update work item status based on review
  const wi = await prisma.workItem.findUnique({ where: { id: existing.workItemId } });
  if (wi) {
    if (wi.workspaceId !== actor.workspaceId) throw new IsolationError();
    if (wi.status !== "waiting_review" && wi.status !== "reviewing") {
      throw new ORPCError("BAD_REQUEST", { message: "WorkItem is not awaiting this review" });
    }
    if (input.status === "approved") {
      await prisma.workItem.update({ where: { id: wi.id }, data: { status: "completed" } });
      await prisma.companyEvent.create({
        data: {
          workspaceId: actor.workspaceId,
          type: "review.completed",
          workItemId: wi.id,
          payload: { reviewId: row.id, status: "approved" } as never,
        },
      });
      await prisma.companyEvent.create({
        data: {
          workspaceId: actor.workspaceId,
          type: "work.completed",
          workItemId: wi.id,
          payload: {} as never,
        },
      });
    } else if (input.status === "changes_requested") {
      await prisma.workItem.update({ where: { id: wi.id }, data: { status: "in_progress" } });
      await prisma.companyEvent.create({
        data: {
          workspaceId: actor.workspaceId,
          type: "review.completed",
          workItemId: wi.id,
          payload: { reviewId: row.id, status: "changes_requested" } as never,
        },
      });
    } else {
      await prisma.companyEvent.create({
        data: {
          workspaceId: actor.workspaceId,
          type: "review.completed",
          workItemId: wi.id,
          payload: { reviewId: row.id, status: "cancelled" } as never,
        },
      });
    }
  }
  return reviewRow(row);
}

// ── SOPs ──
function sopRow(row: {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  trigger: string;
  definition: unknown;
  version: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    definition: row.definition as never,
    version: row.version,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listSops(prisma: PrismaClient, actor: Actor) {
  const rows = await prisma.standardOperatingProcedure.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(sopRow);
}
export async function createSop(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    name: string;
    description?: string;
    trigger: string;
    definition: unknown;
    active?: boolean;
  },
) {
  validateSopDefinition(input.definition as never);
  const row = await prisma.standardOperatingProcedure.create({
    data: {
      workspaceId: actor.workspaceId,
      name: input.name.trim(),
      description: input.description ?? "",
      trigger: input.trigger,
      definition: input.definition as never,
      active: input.active ?? true,
    },
  });
  return sopRow(row);
}
export async function updateSop(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    sopId: string;
    name?: string;
    description?: string;
    trigger?: string;
    definition?: unknown;
    active?: boolean;
  },
) {
  const existing = await prisma.standardOperatingProcedure.findFirst({
    where: { id: input.sopId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "SOP not found" });
  if (input.definition) validateSopDefinition(input.definition as never);
  const row = await prisma.standardOperatingProcedure.update({
    where: { id: input.sopId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      ...(input.definition !== undefined
        ? { definition: input.definition as never, version: existing.version + 1 }
        : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  return sopRow(row);
}
export async function removeSop(prisma: PrismaClient, actor: Actor, sopId: string) {
  const existing = await prisma.standardOperatingProcedure.findFirst({
    where: { id: sopId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "SOP not found" });
  await prisma.standardOperatingProcedure.delete({ where: { id: sopId } });
  return { ok: true as const };
}

// ── Escalations ──
function escalationRow(row: {
  id: string;
  workspaceId: string;
  sourceBotId: string;
  targetBotId: string | null;
  workItemId: string | null;
  reason: string;
  severity: string;
  status: string;
  context: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceBotId: row.sourceBotId,
    targetBotId: row.targetBotId,
    workItemId: row.workItemId,
    reason: row.reason,
    severity: row.severity as never,
    status: row.status as never,
    context: (row.context as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    resolvedAt: toIso(row.resolvedAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export async function listEscalations(prisma: PrismaClient, actor: Actor) {
  const rows = await prisma.escalation.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(escalationRow);
}
export async function createEscalation(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    sourceBotId: string;
    targetBotId?: string | null;
    workItemId?: string | null;
    reason: string;
    severity?: string;
    context?: Record<string, unknown>;
  },
) {
  const srcBot = await prisma.bot.findFirst({
    where: { id: input.sourceBotId, workspaceId: actor.workspaceId, userId: actor.userId },
  });
  if (!srcBot) throw new IsolationError();
  // Determine escalation target: manager chain if not provided
  let targetBotId = input.targetBotId ?? null;
  if (!targetBotId) {
    const profile = await prisma.employeeProfile.findUnique({
      where: { botId: input.sourceBotId },
    });
    targetBotId = profile?.reportsToBotId ?? null;
  }
  if (input.workItemId) {
    const wi = await prisma.workItem.findFirst({
      where: { id: input.workItemId, workspaceId: actor.workspaceId },
    });
    if (!wi) throw new ORPCError("BAD_REQUEST", { message: "WorkItem not found" });
  }
  const row = await prisma.escalation.create({
    data: {
      workspaceId: actor.workspaceId,
      sourceBotId: input.sourceBotId,
      targetBotId,
      workItemId: input.workItemId ?? null,
      reason: input.reason,
      severity: input.severity ?? "medium",
      status: "open",
      context: (input.context ?? {}) as never,
    },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "escalation.created",
      escalationId: row.id,
      workItemId: row.workItemId,
      actorBotId: row.sourceBotId,
      payload: { reason: row.reason } as never,
    },
  });
  // runtime: mark source as blocked if it has current work
  await prisma.employeeRuntimeState.updateMany({
    where: { botId: input.sourceBotId, workspaceId: actor.workspaceId },
    data: { status: "blocked" },
  });
  return escalationRow(row);
}
export async function resolveEscalation(
  prisma: PrismaClient,
  actor: Actor,
  input: { escalationId: string; status?: "resolved" | "cancelled" },
) {
  const existing = await prisma.escalation.findFirst({
    where: { id: input.escalationId, workspaceId: actor.workspaceId },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Escalation not found" });
  const row = await prisma.escalation.update({
    where: { id: input.escalationId },
    data: { status: input.status ?? "resolved", resolvedAt: new Date() },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "escalation.resolved",
      escalationId: row.id,
      payload: {} as never,
    },
  });
  return escalationRow(row);
}

// ── Overview ──
export async function getOverview(prisma: PrismaClient, actor: Actor) {
  const { evaluateCompanyHealth } = await import("@rakazo/organization");
  const health = await evaluateCompanyHealth(prisma, actor.workspaceId);
  const [deptCount, empCount, goals, projects, workItems, reviews, escalations, events] =
    await Promise.all([
      prisma.department.count({ where: { workspaceId: actor.workspaceId } }),
      prisma.employeeProfile.count({ where: { workspaceId: actor.workspaceId } }),
      prisma.companyGoal.count({ where: { workspaceId: actor.workspaceId } }),
      prisma.project.count({ where: { workspaceId: actor.workspaceId } }),
      prisma.workItem.count({ where: { workspaceId: actor.workspaceId } }),
      prisma.workItemReview.count({ where: { workspaceId: actor.workspaceId, status: "pending" } }),
      prisma.escalation.count({
        where: { workspaceId: actor.workspaceId, status: { in: ["open", "acknowledged"] } },
      }),
      prisma.companyEvent.findMany({
        where: { workspaceId: actor.workspaceId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);
  return {
    health,
    counts: {
      departments: deptCount,
      employees: empCount,
      goals,
      projects,
      workItems,
      pendingReviews: reviews,
      openEscalations: escalations,
    },
    recentEvents: events.map((e) => ({
      id: e.id,
      workspaceId: e.workspaceId,
      type: e.type,
      actorBotId: e.actorBotId,
      workItemId: e.workItemId,
      projectId: e.projectId,
      goalId: e.goalId,
      escalationId: e.escalationId,
      payload: (e.payload as Record<string, unknown>) ?? {},
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
export async function listCompanyEvents(prisma: PrismaClient, actor: Actor, limit?: number) {
  const rows = await prisma.companyEvent.findMany({
    where: { workspaceId: actor.workspaceId },
    orderBy: { createdAt: "desc" },
    take: limit ?? 50,
  });
  return rows.map((e) => ({
    id: e.id,
    workspaceId: e.workspaceId,
    type: e.type,
    actorBotId: e.actorBotId,
    workItemId: e.workItemId,
    projectId: e.projectId,
    goalId: e.goalId,
    escalationId: e.escalationId,
    payload: (e.payload as Record<string, unknown>) ?? {},
    createdAt: e.createdAt.toISOString(),
  }));
}

export async function wakeEmployee(prisma: PrismaClient, actor: Actor, botId: string) {
  const profile = await prisma.employeeProfile.findFirst({
    where: { botId, workspaceId: actor.workspaceId },
  });
  if (!profile) throw new ORPCError("NOT_FOUND", { message: "Employee not found" });
  // Acquire lease attempt (optimistic): update runtime nextWakeAt to now, failureCount reset?
  const now = new Date();
  await prisma.employeeRuntimeState.upsert({
    where: { botId },
    create: {
      workspaceId: actor.workspaceId,
      botId,
      status: "idle",
      lastActiveAt: now,
      lastEvaluationAt: now,
      nextWakeAt: now,
    },
    update: { lastActiveAt: now, nextWakeAt: now, status: "idle" },
  });
  await prisma.companyEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      type: "employee.wakeup",
      actorBotId: botId,
      payload: {} as never,
    },
  });
  return { ok: true as const };
}
