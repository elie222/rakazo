import type { AdapterContext } from "@rakazo/adapter-kit";
import { computerControlExpireJobKey } from "@rakazo/adapter-kit";
import { type ComputerUpdate, ComputerUpdateSchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isIdleOwnComputerTakeover } from "./computer-control.js";
import { scheduleComputerSleep } from "./computer-idle.js";
import {
  ComputerBusyError,
  computerSupportsUpdate,
  replaceComputer,
} from "./computer-lifecycle.js";
import { toComputerRef } from "./computer-support.js";

type Deps = Parameters<typeof replaceComputer>[0];
type QueueDeps = Pick<Deps, "prisma" | "jobs"> &
  Partial<Pick<Deps, "sandbox">> & {
    events?: Pick<ThreadEvents, "append">;
  };
const STALE_MS = 10 * 60_000;

export function computerUpdateView(
  row: {
    action: string;
    id: string;
    botId: string;
    status: string;
    stage: string;
    computer: { scope: string; bots: { id: string; name: string }[] };
  },
  isDeploymentOwner = false,
): ComputerUpdate {
  return ComputerUpdateSchema.parse({
    canReleaseReservation: isDeploymentOwner && row.status === "interrupted",
    action: row.action,
    id: row.id,
    botId: row.computer.bots.some((bot) => bot.id === row.botId)
      ? row.botId
      : (row.computer.bots[0]?.id ?? row.botId),
    name: row.computer.bots.find((bot) => bot.id === row.botId)?.name ?? "",
    mode: row.computer.scope === "team" ? "team" : "dedicated",
    status: row.status,
    stage: row.stage,
  });
}

export async function queueComputerUpdate(
  deps: QueueDeps,
  computerId: string,
  botId: string,
  action: "update" | "recover" = "update",
) {
  const prepared = await deps.prisma.$transaction(async (tx) => {
    // Mode switches lock this same row before marking a bot as switching.
    // The following statement then observes their committed reservation.
    await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computerId} FOR UPDATE`;
    const computer = await tx.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (action === "update" && !computerSupportsUpdate(computer.kind))
      throw new Error("Computer update is not available on this device");
    // A run bound to this takeover must keep it. Maintenance does not resume that run.
    if (
      computer.controlHolder === "user" &&
      computer.controlBotId === botId &&
      computer.controlRunId
    ) {
      throw new ComputerBusyError();
    }
    const idleTakeover = isIdleOwnComputerTakeover(computer, botId);
    // Holder "none" plus a lease means a provider revoke failed and control may remain.
    if (computer.controlLeaseId && !idleTakeover) throw new ComputerBusyError();

    let handback: IdleTakeoverHandback | null = null;
    if (idleTakeover) {
      const cleared = await tx.computer.updateMany({
        where: {
          id: computerId,
          controlHolder: "user",
          controlBotId: botId,
          controlRunId: null,
          controlLeaseId: computer.controlLeaseId,
        },
        data: computer.controlLeaseId
          ? { controlHolder: "none" }
          : {
              controlHolder: "none",
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
      });
      // The waiting-run check is this CAS: a run that attached loses the claim with it.
      if (cleared.count !== 1) throw new ComputerBusyError();
      handback = {
        leaseId: computer.controlLeaseId,
        expiresAt: computer.controlLeaseExpiresAt,
        providerRef: computer.providerRef,
        kind: computer.kind,
        homeKey: computer.homeKey,
        spaceId: computer.spaceId,
        userId: computer.userId,
        botId,
      };
    }

    const revokeLeaseId = handback?.leaseId ?? null;
    const update = await tx.computerUpdate.create({
      data: {
        computerId,
        botId,
        action,
        // Hidden from the reconciler until provider control is actually released.
        ...(revokeLeaseId ? { status: "reserving" } : {}),
      },
    });
    const claimed = await tx.computer.updateMany({
      where: {
        id: computerId,
        maintenanceId: null,
        state: { notIn: ["booting", "suspending"] },
        controlHolder: { not: "user" },
        controlLeaseId: revokeLeaseId,
        executionLeases: { none: { expiresAt: { gt: new Date() } } },
        bots: {
          some: { id: botId, archivedAt: null },
          none: {
            OR: [
              { computerSwitching: true },
              { runs: { some: { status: { in: [...ACTIVE_RUN_STATUSES] } } } },
            ],
          },
        },
      },
      data: { maintenanceId: update.id },
    });
    if (claimed.count !== 1) throw new ComputerBusyError();
    await tx.computerUpdate.updateMany({
      where: { computerId, status: "failed" },
      data: { status: "dismissed" },
    });
    const row = await tx.computerUpdate.findUniqueOrThrow({
      where: { id: update.id },
      include: {
        computer: { include: { bots: { where: { id: botId }, select: { id: true, name: true } } } },
      },
    });
    return { row, handback };
  });

  if (prepared.handback?.leaseId && prepared.handback.providerRef) {
    const context: AdapterContext = {
      operationId: prepared.row.id,
      traceId: prepared.row.id,
      spaceId: prepared.handback.spaceId,
      userId: prepared.handback.userId,
      botId,
      signal: new AbortController().signal,
    };
    try {
      await deps.sandbox?.setScreenControl?.(
        toComputerRef(prepared.handback),
        false,
        context,
        prepared.handback.leaseId,
      );
    } catch (error) {
      getLogger().error("release own takeover before maintenance", error);
      await undoQueuedMaintenance(deps.prisma, computerId, prepared.row.id, prepared.handback);
      throw new ComputerBusyError();
    }
    await deps.jobs
      .cancel(computerControlExpireJobKey(computerId, prepared.handback.leaseId))
      .catch((error) => {
        getLogger().error("computer control expiry cancellation", error);
      });
    const released = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        maintenanceId: prepared.row.id,
        controlHolder: "none",
        controlLeaseId: prepared.handback.leaseId,
        controlRunId: null,
      },
      data: {
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    if (released.count !== 1) {
      await dropMaintenanceReservation(deps.prisma, computerId, prepared.row.id);
      throw new ComputerBusyError();
    }
    const queued = await deps.prisma.computerUpdate.updateMany({
      where: { id: prepared.row.id, status: "reserving" },
      data: { status: "queued" },
    });
    if (queued.count !== 1) {
      await dropMaintenanceReservation(deps.prisma, computerId, prepared.row.id);
      throw new ComputerBusyError();
    }
    prepared.row.status = "queued";
  }
  if (prepared.handback) await recordTakeoverHandback(deps, botId, prepared.handback);

  // The reconciler republishes durable queued intent if publishing fails.
  await deps.jobs
    .enqueue({
      name: "computer.update",
      payload: { updateId: prepared.row.id },
      replaceKey: `computer.update:${prepared.row.id}`,
    })
    .catch(() => undefined);
  return computerUpdateView(prepared.row);
}

type IdleTakeoverHandback = {
  leaseId: string | null;
  expiresAt: Date | null;
  providerRef: string | null;
  kind: string;
  homeKey: string;
  spaceId: string;
  userId: string;
  botId: string;
};

async function undoQueuedMaintenance(
  prisma: PrismaClient,
  computerId: string,
  updateId: string,
  handback: IdleTakeoverHandback,
) {
  try {
    await prisma.$transaction(async (tx) => {
      const restored = await tx.computer.updateMany({
        where: {
          id: computerId,
          maintenanceId: updateId,
          controlHolder: "none",
          controlLeaseId: handback.leaseId,
          controlRunId: null,
        },
        data: {
          maintenanceId: null,
          controlHolder: "user",
          controlBotId: handback.botId,
          controlRunId: null,
        },
      });
      if (restored.count !== 1) {
        await tx.computer.updateMany({
          where: { id: computerId, maintenanceId: updateId },
          data: { maintenanceId: null },
        });
      }
      await tx.computerUpdate.deleteMany({ where: { id: updateId, status: "reserving" } });
    });
  } catch (error) {
    getLogger().error("undo maintenance takeover", error);
    await prisma.computerUpdate
      .updateMany({
        where: { id: updateId, status: { in: ["queued", "reserving"] } },
        data: { status: "dismissed" },
      })
      .catch(() => undefined);
    await prisma.computer
      .updateMany({
        where: { id: computerId, maintenanceId: updateId },
        data: { maintenanceId: null },
      })
      .catch(() => undefined);
  }
}

async function dropMaintenanceReservation(
  prisma: PrismaClient,
  computerId: string,
  updateId: string,
) {
  await prisma.$transaction(async (tx) => {
    await tx.computer.updateMany({
      where: { id: computerId, maintenanceId: updateId },
      data: { maintenanceId: null },
    });
    await tx.computerUpdate.deleteMany({ where: { id: updateId, status: "reserving" } });
  });
}

async function recordTakeoverHandback(
  deps: QueueDeps,
  botId: string,
  handback: IdleTakeoverHandback,
) {
  if (!deps.events || !deps.prisma.bot) return;
  try {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: botId },
      select: { thread: { select: { id: true } } },
    });
    if (!bot?.thread) return;
    await deps.events.append({
      spaceId: handback.spaceId,
      threadId: bot.thread.id,
      botId,
      type: "computer.takeover.released",
      payload: { holder: "none", leaseId: handback.leaseId, reason: "released" },
    });
  } catch (error) {
    getLogger().error("maintenance takeover release event", error);
  }
}

export async function performComputerUpdate(deps: Deps, updateId: string) {
  const claimed = await deps.prisma.computerUpdate.updateMany({
    where: { id: updateId, status: "queued" },
    data: { status: "running" },
  });
  if (claimed.count !== 1) return; // Never replay a destructive operation on job redelivery.
  const update = await deps.prisma.computerUpdate.findUniqueOrThrow({
    where: { id: updateId },
    include: { computer: true },
  });
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void deps.prisma.computerUpdate
      .updateMany({ where: { id: updateId, status: "running" }, data: { updatedAt: new Date() } })
      .then((result) => {
        if (result.count !== 1) controller.abort();
      })
      .catch(() => controller.abort());
  }, 30_000);
  try {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: update.botId, computerId: update.computerId, archivedAt: null },
      select: { userId: true },
    });
    if (!bot) throw new Error("Computer update target is unavailable");
    await replaceComputer(
      deps,
      update.computerId,
      update.action === "recover" ? "recover" : "update",
      {
        operationId: updateId,
        traceId: updateId,
        botId: update.botId,
        spaceId: update.computer.spaceId,
        userId: bot.userId,
        signal: controller.signal,
      },
      "none",
      async (stage) => {
        controller.signal.throwIfAborted();
        const result = await deps.prisma.computerUpdate.updateMany({
          where: { id: updateId, status: "running" },
          data: { stage: update.action === "recover" && stage === "saving" ? "preparing" : stage },
        });
        if (result.count !== 1) throw new Error("Computer update interrupted");
      },
    );
    await finishUpdate(deps.prisma, updateId, update.computerId, "completed");
    scheduleComputerSleep(deps.jobs, update.computerId);
  } catch (error) {
    getLogger().error("computer update failed", error, { updateId, computerId: update.computerId });
    // Provider errors may contain credentials or private URLs. Expose only the failed stage.
    await finishUpdate(deps.prisma, updateId, update.computerId, "failed");
  } finally {
    clearInterval(heartbeat);
  }
}

async function finishUpdate(
  prisma: PrismaClient,
  id: string,
  computerId: string,
  status: "completed" | "failed",
) {
  await prisma.$transaction(async (tx) => {
    const finished = await tx.computerUpdate.updateMany({
      where: { id, status: { in: ["running", "interrupted"] } },
      data: { status },
    });
    if (finished.count !== 1) return;
    await tx.computer.updateMany({
      where: { id: computerId, maintenanceId: id },
      data: { maintenanceId: null },
    });
  });
}

export async function reconcileComputerUpdates(deps: Pick<Deps, "prisma" | "jobs">) {
  const updates = await deps.prisma.computerUpdate.findMany({
    where: {
      OR: [
        { status: "queued" },
        { status: "running", updatedAt: { lt: new Date(Date.now() - STALE_MS) } },
        { status: "reserving", updatedAt: { lt: new Date(Date.now() - STALE_MS) } },
      ],
    },
    take: 100,
    orderBy: { updatedAt: "asc" },
  });
  for (const update of updates) {
    if (update.status === "queued") {
      await deps.jobs.enqueue({
        name: "computer.update",
        payload: { updateId: update.id },
        replaceKey: `computer.update:${update.id}`,
      });
    } else if (update.status === "reserving") {
      await deps.prisma.$transaction(async (tx) => {
        const stale = await tx.computerUpdate.updateMany({
          where: { id: update.id, status: "reserving", updatedAt: update.updatedAt },
          data: { status: "failed" },
        });
        if (stale.count !== 1) return;
        await tx.computer.updateMany({
          where: { id: update.computerId, maintenanceId: update.id },
          data: { maintenanceId: null },
        });
      });
    } else {
      await deps.prisma.$transaction(async (tx) => {
        const stale = await tx.computerUpdate.updateMany({
          where: { id: update.id, status: "running", updatedAt: update.updatedAt },
          data: { status: "interrupted" },
        });
        // A stale heartbeat is not proof that provider calls have stopped. Only
        // the worker's settled path can release this reservation.
        if (stale.count !== 1) return;
      });
    }
  }
}
