import { mkdir } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { type PrismaClient, parseComputerMode, type ThreadEvents } from "@rakazo/db";
import { expireComputerControl, hasActiveComputerControl } from "./computer-control.js";
import { ensureComputerWorkspaceLayout, restoreComputerWorkspace } from "./computer-workspace.js";
import { resolveAgentHomePath } from "./home.js";

const EXECUTION_LEASE_MS = 5 * 60_000;

export class ComputerBusyError extends Error {
  constructor() {
    super("Computer is busy");
    this.name = "ComputerBusyError";
  }
}

export { toComputerRef } from "./computer-support.js";

export async function provisionComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
  },
  computerId: string,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
): Promise<ComputerRef> {
  let existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  const homePath = resolveAgentHomePath(deps.home, existing.homeKey, deps.dataDir ?? "./data");
  await mkdir(homePath, { recursive: true });
  const claimed = await deps.prisma.computer.updateMany({
    where: { id: computerId, state: { not: "suspending" } },
    data: { state: "booting" },
  });
  if (claimed.count !== 1) throw new ComputerBusyError();
  let provisioned: ComputerRef | undefined;
  try {
    const ref = await deps.sandbox.provision(
      {
        botId: existing.homeKey,
        homePath,
        providerRef: existing.providerRef ?? undefined,
        providerKind: existing.kind as ComputerRef["kind"],
      },
      context,
    );
    provisioned = ref;
    const replacement =
      ref.fresh === true ||
      !existing.providerRef ||
      existing.providerRef !== ref.providerRef ||
      existing.kind !== ref.kind;
    if (replacement) {
      await restoreComputerWorkspace(deps.home, deps.sandbox, existing.homeKey, ref, context);
    }
    await ensureComputerWorkspaceLayout(
      deps.sandbox,
      ref,
      parseComputerMode(existing.scope),
      context.botId,
      context,
    );
    const activeControl = hasActiveComputerControl(existing);
    await deps.prisma.computer.update({
      where: { id: computerId },
      data: {
        state: "running",
        providerRef: ref.providerRef,
        kind: ref.kind,
        controlHolder: activeControl ? "user" : controlHolder,
        ...(!activeControl
          ? { controlLeaseId: null, controlLeaseExpiresAt: null, controlBotId: null }
          : {}),
      },
    });
    return ref;
  } catch (error) {
    if (provisioned?.fresh) await deps.sandbox.destroy(provisioned, context).catch(() => undefined);
    await deps.prisma.computer.updateMany({
      where: { id: computerId },
      data: { state: "error" },
    });
    throw error;
  }
}

export interface ComputerExecutionLease {
  computerId: string;
  runId: string;
  fence: number;
}

export async function acquireComputerExecutionLease(
  prisma: PrismaClient,
  input: {
    computerId: string;
    runId: string;
    botId: string;
    resumeHeldLease?: boolean;
  },
): Promise<ComputerExecutionLease | null> {
  const computer = await prisma.computer.findUniqueOrThrow({ where: { id: input.computerId } });
  if (computer.scope !== "team") return null;
  const now = new Date();
  const [leased] = await prisma.computer.updateManyAndReturn({
    where: {
      id: input.computerId,
      state: { not: "suspending" },
      controlHolder: { not: "user" },
      OR: [
        { executionRunId: null },
        ...(input.resumeHeldLease ? [{ executionRunId: input.runId }] : []),
        {
          executionLeaseExpiresAt: { lt: now },
          controlHolder: { not: "user" },
        },
      ],
    },
    data: {
      executionRunId: input.runId,
      executionBotId: input.botId,
      executionLeaseExpiresAt: new Date(now.getTime() + EXECUTION_LEASE_MS),
      executionFence: { increment: 1 },
    },
    select: { executionFence: true },
  });
  if (!leased) throw new ComputerBusyError();
  return { computerId: input.computerId, runId: input.runId, fence: leased.executionFence };
}

export async function renewComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const renewed = await prisma.computer.updateMany({
    where: {
      id: lease.computerId,
      executionRunId: lease.runId,
      executionFence: lease.fence,
      controlHolder: { not: "user" },
    },
    data: { executionLeaseExpiresAt: new Date(Date.now() + EXECUTION_LEASE_MS) },
  });
  return renewed.count === 1;
}

export async function holdComputerExecutionLeaseForTakeover(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const held = await prisma.computer.updateMany({
    where: {
      id: lease.computerId,
      executionRunId: lease.runId,
      executionFence: lease.fence,
      controlHolder: { not: "user" },
    },
    data: { executionLeaseExpiresAt: new Date(Date.now() + 24 * 60 * 60_000) },
  });
  return held.count === 1;
}

export async function releaseComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<void> {
  if (!lease) return;
  await prisma.computer.updateMany({
    where: {
      id: lease.computerId,
      executionRunId: lease.runId,
      executionFence: lease.fence,
    },
    data: {
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
    },
  });
}
