import {
  type AdapterContext,
  computerControlExpireJob,
  type JobPublisher,
  type SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";

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
  botId: string,
  leaseId: string,
  expiresAt: Date,
): Promise<void> {
  return jobs.enqueue(computerControlExpireJob(botId, leaseId, expiresAt));
}

export async function expireComputerControl(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  botId: string,
  leaseId: string,
  now = new Date(),
): Promise<boolean> {
  const computer = await deps.prisma.computer.findUnique({ where: { botId } });
  if (!computer || computer.controlLeaseId !== leaseId) return false;

  if (computer.controlLeaseExpiresAt && computer.controlLeaseExpiresAt.getTime() > now.getTime()) {
    await scheduleComputerControlExpiry(deps.jobs, botId, leaseId, computer.controlLeaseExpiresAt);
    return false;
  }

  // Deny API input before touching the provider. Retaining the lease ID makes a
  // failed provider revocation recoverable by the job retry or reconciler.
  const claimed = await deps.prisma.computer.updateMany({
    where: { botId, controlLeaseId: leaseId },
    data: { controlHolder: "none" },
  });
  if (claimed.count !== 1) return false;

  if (computer.providerRef) {
    const context: AdapterContext = {
      operationId: "computer.control-expire",
      traceId: "computer.control-expire",
      workspaceId: computer.workspaceId,
      userId: computer.userId,
      botId,
      signal: new AbortController().signal,
    };
    await deps.sandbox.setScreenControl?.(
      {
        id: computer.providerRef,
        botId,
        kind: computer.kind as "docker" | "e2b" | "desktop" | "fake",
        providerRef: computer.providerRef,
      },
      false,
      context,
      leaseId,
    );
  }

  return deps.events.finalizeComputerControlRelease({
    workspaceId: computer.workspaceId,
    botId,
    leaseId,
    holder: "none",
    reason: "expired",
  });
}
