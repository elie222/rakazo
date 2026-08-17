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
    where: {
      id: computerId,
      state: { not: "suspending" },
      ...(context.botId ? { bots: { some: { id: context.botId, archivedAt: null } } } : {}),
    },
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
    await deps.sandbox.prepare(ref, context);
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
    const activated = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        state: "booting",
        ...(context.botId ? { bots: { some: { id: context.botId, archivedAt: null } } } : {}),
      },
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
    if (activated.count !== 1) {
      throw new ComputerBusyError();
    }
    return ref;
  } catch (error) {
    const rollbackError = provisioned
      ? await rollbackProvisionedComputer(deps.sandbox, provisioned, context, error)
      : undefined;
    try {
      await deps.prisma.computer.updateMany({
        where: { id: computerId, state: "booting" },
        data: {
          state: "error",
          ...(rollbackError && provisioned
            ? { providerRef: provisioned.providerRef, kind: provisioned.kind }
            : {}),
        },
      });
    } catch (recordError) {
      throw new AggregateError(
        [error, ...(rollbackError ? [rollbackError] : []), recordError],
        "Computer provisioning failed and its failure could not be recorded",
      );
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Computer provisioning failed and its sandbox could not be rolled back",
      );
    }
    throw error;
  }
}

async function rollbackProvisionedComputer(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  cause: unknown,
): Promise<unknown | undefined> {
  try {
    if (computer.fresh) {
      await sandbox.destroy(computer, context);
    } else if (cause instanceof ComputerBusyError) {
      try {
        await sandbox.stop(computer, context);
      } catch {
        await sandbox.destroy(computer, context);
      }
    } else {
      await sandbox.stop(computer, context);
    }
    return undefined;
  } catch (error) {
    return error;
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
