import {
  computerScreenSize,
  computerSupportsTerminal,
  computerSupportsUpdate,
  DISK_WARNING_PERCENT,
  diskUsedPercent,
  holdsUserControl,
} from "@rakazo/adapters";
import type { ComputerStatus } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** Mirrors computer.takeover: an execution lease blocks user control unless a takeover is pending. */
export function executionBlocksUserTakeover(input: {
  hasLease: boolean;
  leaseExpiresAt: Date | null | undefined;
  runStatus: string | null | undefined;
  now?: number;
  takeoverRequested?: boolean;
}): boolean {
  if (!input.hasLease) return false;
  if (input.runStatus === "waiting_takeover" || input.takeoverRequested) return false;
  const now = input.now ?? Date.now();
  const leaseActive = Boolean(input.leaseExpiresAt && input.leaseExpiresAt.getTime() > now);
  const runActive = Boolean(
    input.runStatus && (ACTIVE_RUN_STATUSES as readonly string[]).includes(input.runStatus),
  );
  return leaseActive || runActive;
}

export async function resolveBusyBotName(
  prisma: PrismaClient,
  input: {
    computerId: string | null | undefined;
    botId: string;
    botName: string;
  },
): Promise<string | null> {
  if (!input.computerId) return null;
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: input.computerId, botId: input.botId } },
    select: { expiresAt: true, runId: true, computer: { select: { controlRunId: true } } },
  });
  if (!lease) return null;
  const run = await prisma.run.findUnique({
    where: { id: lease.runId },
    select: { status: true },
  });
  return executionBlocksUserTakeover({
    hasLease: true,
    leaseExpiresAt: lease.expiresAt,
    runStatus: run?.status,
    takeoverRequested: lease.computer.controlRunId === lease.runId,
  })
    ? input.botName
    : null;
}

export type ComputerControlView = {
  /** The person in control, when it is not the viewer. */
  controllerName?: string | null;
  /** The bot whose request for help the user has not opened yet. */
  requestBotId?: string | null;
  /** That unopened request waits for another person, so this viewer only watches. */
  requestForOther?: boolean;
};

/** Who the computer's control belongs to, beyond what its row says. */
export async function resolveComputerControl(
  prisma: PrismaClient,
  computer:
    | {
        controlHolder: string;
        controlBotId?: string | null;
        controlRunId?: string | null;
        controlUserId?: string | null;
        userId?: string | null;
      }
    | null
    | undefined,
  viewerId: string | undefined,
): Promise<ComputerControlView> {
  const runId = computer?.controlBotId ? null : computer?.controlRunId;
  const run = runId
    ? await prisma.run.findUnique({ where: { id: runId }, select: { botId: true, userId: true } })
    : null;
  // A lease from before holders were recorded belongs to the person the computer is kept for.
  const holderId =
    computer?.controlHolder === "user" ? computer.controlUserId || computer.userId : run?.userId;
  const otherId = viewerId && holderId && holderId !== viewerId ? holderId : null;
  const user = otherId
    ? await prisma.user.findUnique({ where: { id: otherId }, select: { name: true } })
    : null;
  return {
    controllerName: user?.name || null,
    requestBotId: run?.botId ?? null,
    requestForOther: Boolean(run && otherId),
  };
}

export function toComputerStatus(
  botId: string,
  computer: {
    kind: string;
    state: string;
    scope: string;
    controlHolder: string;
    controlBotId?: string | null;
    controlRunId?: string | null;
    homeRevision: string;
    maintenanceId?: string | null;
    diskUsedBytes?: bigint | null;
    diskFreeBytes?: bigint | null;
    diskDismissedPercent?: number | null;
    controlUserId?: string | null;
    userId?: string | null;
  } | null,
  busyBotName: string | null = null,
  shared = false,
  viewerId?: string,
  control: ComputerControlView = {},
): ComputerStatus {
  const controlledByOther =
    Boolean(
      viewerId && computer?.controlHolder === "user" && !holdsUserControl(computer, viewerId),
    ) || Boolean(control.requestForOther);
  const kind = (computer?.kind ?? "fake") as ComputerStatus["kind"];
  const state =
    kind === "none"
      ? "stopped"
      : computer?.maintenanceId
        ? "booting"
        : computer?.state === "quarantined"
          ? "error"
          : computer?.state === "suspending"
            ? "running"
            : computer?.state === "stopped" ||
                computer?.state === "booting" ||
                computer?.state === "running" ||
                computer?.state === "suspended" ||
                computer?.state === "error"
              ? computer.state
              : "stopped";
  const screen = computerScreenSize(computer?.kind);
  const diskPercent = computer ? diskUsedPercent(computer) : null;
  const diskFull =
    diskPercent !== null &&
    diskPercent >= DISK_WARNING_PERCENT &&
    diskPercent > (computer?.diskDismissedPercent ?? 0);
  return {
    botId,
    ...(shared ? { shared } : {}),
    ...(controlledByOther ? { controlledByOther } : {}),
    ...(controlledByOther && control.controllerName
      ? { controlledByName: control.controllerName }
      : {}),
    mode: computer?.scope === "dedicated" ? "dedicated" : "team",
    kind,
    state,
    controlHolder: (computer?.controlHolder ?? "none") as ComputerStatus["controlHolder"],
    controlBotId: computer?.controlBotId ?? control.requestBotId ?? null,
    takeoverRequested: Boolean(computer?.controlRunId),
    screenAvailable: !computer?.maintenanceId && (state === "running" || state === "booting"),
    screenWidth: screen.width,
    screenHeight: screen.height,
    homeRevision: computer?.homeRevision ?? null,
    busyBotName,
    canUpdate: computerSupportsUpdate(kind),
    terminalAvailable: computerSupportsTerminal(kind),
    ...(diskFull ? { diskFullPercent: diskPercent } : {}),
  };
}
