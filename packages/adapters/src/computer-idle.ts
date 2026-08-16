import {
  type AgentHomeStore,
  type ComputerRef,
  computerSleepJob,
  type JobPublisher,
  type SandboxProvider,
} from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { expireComputerControl, hasActiveComputerControl } from "./computer-control.js";
import { checkpointAndRecordComputerWorkspace } from "./computer-workspace.js";

export const DEFAULT_SANDBOX_IDLE_MS = 10 * 60 * 1000;

export function sandboxIdleMs(): number {
  const raw = Number(process.env.SANDBOX_IDLE_MS ?? DEFAULT_SANDBOX_IDLE_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_SANDBOX_IDLE_MS;
}

export function scheduleComputerSleep(jobs: JobPublisher, botId: string): void {
  if (!botId) return;
  void jobs.enqueue(computerSleepJob(botId, new Date(Date.now() + sandboxIdleMs())));
}

export async function touchRunningComputer(
  deps: { sandbox: SandboxProvider; jobs: JobPublisher },
  computer: { botId: string; providerRef: string; kind: string },
): Promise<void> {
  scheduleComputerSleep(deps.jobs, computer.botId);
  await deps.sandbox.keepAlive?.({
    id: computer.providerRef,
    botId: computer.botId,
    kind: computer.kind as ComputerRef["kind"],
    providerRef: computer.providerRef,
  });
}

export async function sleepComputerIfIdle(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  botId: string,
): Promise<void> {
  let computer = await deps.prisma.computer.findUnique({ where: { botId } });
  if (!computer?.providerRef) return;
  if (computer.state !== "running") return;
  if (computer.controlLeaseId && !hasActiveComputerControl(computer)) {
    await expireComputerControl(deps, botId, computer.controlLeaseId);
    computer = await deps.prisma.computer.findUnique({ where: { botId } });
    if (!computer?.providerRef || computer.state !== "running") return;
  }
  const activeStatuses = hasActiveComputerControl(computer)
    ? [...ACTIVE_RUN_STATUSES]
    : ACTIVE_RUN_STATUSES.filter((status) => status !== "waiting_takeover");
  const active = await deps.prisma.run.findFirst({
    where: { botId, status: { in: activeStatuses } },
    select: { id: true },
  });
  if (active) {
    scheduleComputerSleep(deps.jobs, botId);
    return;
  }
  const ctx = {
    operationId: "computer.sleep",
    traceId: "computer.sleep",
    workspaceId: computer.workspaceId,
    userId: computer.userId,
    botId,
    signal: new AbortController().signal,
  };
  const ref = {
    id: computer.providerRef,
    botId,
    kind: computer.kind as "docker" | "e2b" | "desktop" | "fake",
    providerRef: computer.providerRef,
  };
  await checkpointAndRecordComputerWorkspace(deps, botId, ref, ctx);
  const [current, activeAfterCheckpoint] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: { botId },
      select: { state: true, providerRef: true, updatedAt: true },
    }),
    deps.prisma.run.findFirst({
      where: { botId, status: { in: activeStatuses } },
      select: { id: true },
    }),
  ]);
  if (
    activeAfterCheckpoint ||
    current?.state !== "running" ||
    current.providerRef !== computer.providerRef ||
    current.updatedAt.getTime() !== computer.updatedAt.getTime()
  ) {
    scheduleComputerSleep(deps.jobs, botId);
    return;
  }
  await deps.sandbox.stop(ref, ctx);
  await deps.prisma.computer.update({
    where: { botId },
    data: {
      state: "suspended",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    },
  });
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    include: { thread: true },
  });
  if (bot?.thread) {
    await deps.events.append({
      workspaceId: computer.workspaceId,
      threadId: bot.thread.id,
      botId,
      type: "computer.status",
      payload: { status: "suspended" },
    });
  }
}
