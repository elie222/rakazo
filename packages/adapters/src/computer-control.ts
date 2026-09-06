import {
  type AdapterContext,
  computerControlExpireJob,
  type JobPublisher,
  runContinueJob,
  type SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { toComputerRef } from "./computer-support.js";

export const DEFAULT_TAKEOVER_LEASE_MS = 15 * 60 * 1000;

export function takeoverLeaseMs(): number {
  const raw = Number(process.env.COMPUTER_TAKEOVER_TTL_MS ?? DEFAULT_TAKEOVER_LEASE_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_TAKEOVER_LEASE_MS;
}

export function hasActiveComputerControl(
  computer:
    | {
        controlHolder: string;
        controlLeaseId: string | null;
        controlLeaseExpiresAt: Date | null;
      }
    | null
    | undefined,
  now = new Date(),
): boolean {
  return Boolean(
    computer?.controlHolder === "user" &&
      computer.controlLeaseId &&
      computer.controlLeaseExpiresAt &&
      computer.controlLeaseExpiresAt.getTime() > now.getTime(),
  );
}

export function scheduleComputerControlExpiry(
  jobs: JobPublisher,
  computerId: string,
  leaseId: string,
  expiresAt: Date,
): Promise<void> {
  return jobs.enqueue(computerControlExpireJob(computerId, leaseId, expiresAt));
}

export async function enqueueTakeoverContinuation(
  jobs: JobPublisher,
  runId: string | null,
): Promise<void> {
  if (!runId) return;
  try {
    await jobs.enqueue(runContinueJob(runId));
  } catch (error) {
    // The release is durable; reconciliation will retry this queued run.
    getLogger().error("takeover continuation enqueue", error);
  }
}

export function teachingControlLeaseExpiresAt(teachingExpiresAt: Date, now = new Date()): Date {
  return new Date(Math.max(now.getTime() + takeoverLeaseMs(), teachingExpiresAt.getTime()));
}

export async function extendActiveComputerControl(
  prisma: PrismaClient,
  jobs: JobPublisher,
  computer: {
    id: string;
    controlHolder: string;
    controlLeaseId: string | null;
    controlLeaseExpiresAt: Date | null;
    controlBotId: string | null;
  },
  botId: string,
  until: Date,
  now = new Date(),
): Promise<boolean> {
  if (
    !hasActiveComputerControl(computer, now) ||
    computer.controlBotId !== botId ||
    !computer.controlLeaseId
  ) {
    return false;
  }
  const expiresAt = teachingControlLeaseExpiresAt(until, now);
  const extended = await prisma.computer.updateMany({
    where: {
      id: computer.id,
      controlHolder: "user",
      controlBotId: botId,
      controlLeaseId: computer.controlLeaseId,
    },
    data: { controlLeaseExpiresAt: expiresAt },
  });
  if (extended.count !== 1) return false;
  await scheduleComputerControlExpiry(jobs, computer.id, computer.controlLeaseId, expiresAt);
  return true;
}

/** Clears controlHolder=user when no live control lease remains (stale / orphaned rows). */
export async function clearInactiveUserComputerControl(
  prisma: PrismaClient,
  computerId: string,
  now = new Date(),
): Promise<boolean> {
  const cleared = await prisma.computer.updateMany({
    where: {
      id: computerId,
      controlHolder: "user",
      OR: [
        { controlLeaseId: null },
        { controlLeaseExpiresAt: null },
        { controlLeaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    },
  });
  return cleared.count === 1;
}

export async function expireComputerControl(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  computerId: string,
  leaseId: string,
  now = new Date(),
): Promise<boolean> {
  const computer = await deps.prisma.computer.findUnique({ where: { id: computerId } });
  if (!computer || computer.controlLeaseId !== leaseId) return false;
  const botId = computer.controlBotId;
  if (!botId) {
    if (
      computer.controlLeaseExpiresAt &&
      computer.controlLeaseExpiresAt.getTime() > now.getTime()
    ) {
      await scheduleComputerControlExpiry(
        deps.jobs,
        computer.id,
        leaseId,
        computer.controlLeaseExpiresAt,
      );
      return false;
    }
    // Orphaned user control: revoke the provider stream, then clear this lease id.
    if (computer.providerRef) {
      const context: AdapterContext = {
        operationId: "computer.control-expire",
        traceId: "computer.control-expire",
        spaceId: computer.spaceId,
        userId: computer.userId,
        signal: new AbortController().signal,
      };
      try {
        await deps.sandbox.setScreenControl?.(toComputerRef(computer), false, context, leaseId);
      } catch {
        // Keep the lease id and try to reschedule so reconciler/status can retry.
        try {
          await scheduleComputerControlExpiry(
            deps.jobs,
            computer.id,
            leaseId,
            new Date(now.getTime() + 30_000),
          );
        } catch (error) {
          getLogger().error("orphan computer control expiry reschedule", error);
        }
        return false;
      }
    }
    const cleared = await deps.prisma.computer.updateMany({
      where: { id: computer.id, controlLeaseId: leaseId },
      data: {
        controlHolder: "none",
        controlLeaseId: null,
        controlLeaseExpiresAt: null,
        controlBotId: null,
        controlRunId: null,
      },
    });
    return cleared.count === 1;
  }

  if (computer.controlLeaseExpiresAt && computer.controlLeaseExpiresAt.getTime() > now.getTime()) {
    await scheduleComputerControlExpiry(
      deps.jobs,
      computer.id,
      leaseId,
      computer.controlLeaseExpiresAt,
    );
    return false;
  }

  // Deny API input before touching the provider. Retaining the lease ID makes a
  // failed provider revocation recoverable by the job retry or reconciler.
  const claimed = await deps.prisma.computer.updateMany({
    where: { id: computer.id, controlLeaseId: leaseId },
    data: { controlHolder: "none" },
  });
  if (claimed.count !== 1) return false;

  if (computer.providerRef) {
    const context: AdapterContext = {
      operationId: "computer.control-expire",
      traceId: "computer.control-expire",
      spaceId: computer.spaceId,
      userId: computer.userId,
      botId,
      signal: new AbortController().signal,
    };
    await deps.sandbox.setScreenControl?.(toComputerRef(computer), false, context, leaseId);
  }

  const released = await deps.events.finalizeComputerControlRelease({
    spaceId: computer.spaceId,
    computerId: computer.id,
    botId,
    runId: computer.controlRunId,
    leaseId,
    holder: "none",
    reason: "expired",
  });
  await enqueueTakeoverContinuation(deps.jobs, released ? released.runId : null);
  return Boolean(released);
}
