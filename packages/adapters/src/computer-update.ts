import { type ComputerUpdate, ComputerUpdateSchema } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { scheduleComputerSleep } from "./computer-idle.js";
import {
  ComputerBusyError,
  computerSupportsUpdate,
  replaceComputer,
} from "./computer-lifecycle.js";

type Deps = Parameters<typeof replaceComputer>[0];
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
  deps: Pick<Deps, "prisma" | "jobs">,
  computerId: string,
  botId: string,
  action: "update" | "recover" = "update",
) {
  const update = await deps.prisma.$transaction(async (tx) => {
    // Mode switches lock this same row before marking a bot as switching.
    // The following statement then observes their committed reservation.
    await tx.$queryRaw`SELECT id FROM computers WHERE id = ${computerId} FOR UPDATE`;
    const computer = await tx.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (action === "update" && !computerSupportsUpdate(computer.kind))
      throw new Error("Computer update is not available on this device");
    const update = await tx.computerUpdate.create({ data: { computerId, botId, action } });
    const claimed = await tx.computer.updateMany({
      where: {
        id: computerId,
        maintenanceId: null,
        state: { notIn: ["booting", "suspending"] },
        controlHolder: { not: "user" },
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
    return tx.computerUpdate.findUniqueOrThrow({
      where: { id: update.id },
      include: {
        computer: { include: { bots: { where: { id: botId }, select: { id: true, name: true } } } },
      },
    });
  });
  // The reconciler republishes durable queued intent if publishing fails.
  await deps.jobs
    .enqueue({
      name: "computer.update",
      payload: { updateId: update.id },
      replaceKey: `computer.update:${update.id}`,
    })
    .catch(() => undefined);
  return computerUpdateView(update);
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
