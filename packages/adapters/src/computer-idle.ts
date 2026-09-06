import {
  type AdapterContext,
  type AgentHomeStore,
  type ComputerRef,
  computerSleepJob,
  type JobPublisher,
  type SandboxProvider,
} from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { expireComputerControl, hasActiveComputerControl } from "./computer-control.js";
import { toComputerRef } from "./computer-lifecycle.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";

export const DEFAULT_SANDBOX_IDLE_MS = 10 * 60 * 1000;
const BACKGROUND_WORK_MARKER_PREFIX = "/tmp/rakazo-background-";
const BACKGROUND_WORK_IDLE_SENTINEL = "rakazo-background-idle";

export const BACKGROUND_WORK_LAUNCH = [
  `marker="${BACKGROUND_WORK_MARKER_PREFIX}$1-$2-$3"`,
  "set -o noclobber",
  'exec 9>"$marker" || exit 1',
  "set +o noclobber",
  'exec bash -lc "$4"',
].join("\n");

/** Terminate background shell wrappers for one cancelled run. Browser teardown stays screen-scoped. */
export const CANCEL_COMPUTER_RUN_WORK = [
  'computerId="$1"',
  'runId="$2"',
  '[ -n "$computerId" ] && [ -n "$runId" ] || exit 0',
  `prefix="${BACKGROUND_WORK_MARKER_PREFIX}$computerId-$runId-"`,
  // Match the timeout wrapper cmdline (still contains the launch tag after exec into the user command).
  'pkill -TERM -f "rakazo-background-launch ${computerId} ${runId} " 2>/dev/null || true',
  "if [ -d /proc ]; then",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)" || continue',
  '    case "$target" in',
  '      "$prefix"*)',
  '        pid="${fd#/proc/}"; pid="${pid%%/*}"',
  '        if [ -n "$pid" ] && [ "$pid" -eq "$pid" ] 2>/dev/null; then',
  // Never kill -PID (process group): sandbox work often shares the caller's PGID.
  '          kill -TERM "$pid" 2>/dev/null || true',
  "        fi",
  "        ;;",
  "    esac",
  "  done",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -TERM "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "fi",
  "sleep 0.2",
  'pkill -KILL -f "rakazo-background-launch ${computerId} ${runId} " 2>/dev/null || true',
  "if [ -d /proc ]; then",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)" || continue',
  '    case "$target" in',
  '      "$prefix"*)',
  '        pid="${fd#/proc/}"; pid="${pid%%/*}"',
  '        if [ -n "$pid" ] && [ "$pid" -eq "$pid" ] 2>/dev/null; then',
  '          kill -KILL "$pid" 2>/dev/null || true',
  "        fi",
  "        ;;",
  "    esac",
  "  done",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -KILL "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "fi",
  'rm -f -- "$prefix"* 2>/dev/null || true',
].join("\n");

/**
 * Kill the primary browser session without matching chromium-screen-* profiles.
 * Covers Docker (--user-data-dir=.../chromium) and portable launches that only
 * use the symlinked primary profile (E2B desktop.launch / Daytona nohup).
 */
export const CANCEL_PRIMARY_BROWSER_WORK = [
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -TERM -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  // Portable primary browsers often omit --user-data-dir; match argv0 only so
  // unrelated processes (e.g. node --engine=chromium) are not killed.
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  '      kill -TERM "${pid#/proc/}" 2>/dev/null || true',
  "      ;;",
  "  esac",
  "done; fi",
  "sleep 0.2",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium$' || true",
  "pkill -KILL -f -- '--user-data-dir=.*/.browser-profiles/chromium ' || true",
  "if [ -d /proc ]; then for pid in /proc/[0-9]*; do",
  '  cmdline="$(tr "\\0" " " <"$pid/cmdline" 2>/dev/null)" || continue',
  '  case "$cmdline" in *chromium-screen-*) continue ;; esac',
  '  argv0=""; IFS= read -r -d "" argv0 <"$pid/cmdline" || true',
  '  case "$argv0" in',
  "    */google-chrome|*/google-chrome-*|google-chrome|google-chrome-*|*/chromium|*/chromium-*|chromium|chromium-*|*/chrome|chrome|*/firefox|*/firefox-*|firefox|firefox-*)",
  '      kill -KILL "${pid#/proc/}" 2>/dev/null || true',
  "      ;;",
  "  esac",
  "done; fi",
  'rm -f "$HOME/.browser-profiles/chromium/SingletonLock" "$HOME/.browser-profiles/chromium/SingletonCookie" "$HOME/.browser-profiles/chromium/SingletonSocket" 2>/dev/null || true',
].join("; ");

export function cancelComputerRunWorkArgv(computerId: string, runId: string): string[] {
  return ["bash", "-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId];
}

export async function cancelComputerRunWork(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  computerId: string,
  runId: string,
  context: AdapterContext,
): Promise<void> {
  if (!computerId || !runId) return;
  try {
    for await (const _event of sandbox.execute(
      computer,
      { argv: cancelComputerRunWorkArgv(computerId, runId), timeoutMs: 15_000 },
      context,
    )) {
      // Drain so providers can finish the exec session.
    }
  } catch {
    // Best effort after the run is already cancelled.
  }
}

export const BACKGROUND_WORK_PROBE = [
  `prefix="${BACKGROUND_WORK_MARKER_PREFIX}$1-"`,
  `idle() { printf '${BACKGROUND_WORK_IDLE_SENTINEL}\\n'; exit 1; }`,
  'markers=("$prefix"*)',
  "if [ -d /proc ]; then",
  "  command -v readlink >/dev/null 2>&1 || exit 2",
  "  for fd in /proc/[0-9]*/fd/*; do",
  '    target="$(readlink "$fd" 2>/dev/null)"',
  '    case "$target" in "$prefix"*) exit 0 ;; esac',
  "  done",
  `  for marker in "\${markers[@]}"; do [ -e "$marker" ] && rm -f -- "$marker"; done`,
  "  idle",
  "fi",
  'if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then',
  "  command -v lsof >/dev/null 2>&1 || exit 2",
  `  for marker in "\${markers[@]}"; do`,
  '    [ -e "$marker" ] || continue',
  '    lsof -t -- "$marker" >/dev/null 2>&1 && exit 0',
  '    rm -f -- "$marker"',
  "  done",
  "  idle",
  "fi",
  "exit 2",
].join("\n");

export function sandboxIdleMs(): number {
  const raw = Number(process.env.SANDBOX_IDLE_MS ?? DEFAULT_SANDBOX_IDLE_MS);
  return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_SANDBOX_IDLE_MS;
}

export function scheduleComputerSleep(jobs: JobPublisher, computerId: string): void {
  if (!computerId) return;
  void jobs.enqueue(computerSleepJob(computerId, new Date(Date.now() + sandboxIdleMs())));
}

export async function touchRunningComputer(
  deps: { sandbox: SandboxProvider; jobs: JobPublisher },
  computer: { id: string; homeKey: string; providerRef: string; kind: string },
): Promise<void> {
  scheduleComputerSleep(deps.jobs, computer.id);
  await deps.sandbox.keepAlive?.(toComputerRef(computer));
}

export async function sleepComputerIfIdle(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
  },
  computerId: string,
): Promise<void> {
  let computer = await loadComputer(deps.prisma, computerId);
  if (!computer?.providerRef || computer.state !== "running") return;

  if (computer.controlBotId && computer.controlLeaseId && !hasActiveComputerControl(computer)) {
    await expireComputerControl(deps, computer.id, computer.controlLeaseId);
    computer = await loadComputer(deps.prisma, computerId);
    if (!computer?.providerRef || computer.state !== "running") return;
  }

  const activeStatuses = hasActiveComputerControl(computer)
    ? [...ACTIVE_RUN_STATUSES]
    : ACTIVE_RUN_STATUSES.filter((status) => status !== "waiting_takeover");
  if (await findActiveRun(deps.prisma, computerId, activeStatuses)) {
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }

  const ref = toComputerRef(computer);
  const ctx: AdapterContext = {
    operationId: "computer.sleep",
    traceId: "computer.sleep",
    spaceId: computer.spaceId,
    userId: computer.userId,
    botId: computer.controlBotId ?? undefined,
    signal: new AbortController().signal,
  };
  if (await hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId)) {
    scheduleComputerSleep(deps.jobs, computerId);
    await deps.sandbox.keepAlive?.(ref);
    return;
  }

  const revision = await checkpointComputerWorkspace(
    deps.home,
    deps.sandbox,
    computer.homeKey,
    ref,
    ctx,
  );
  const checkpointedAt = new Date();
  const recorded = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: "running",
      providerRef: computer.providerRef,
      updatedAt: computer.updatedAt,
      executionRunId: null,
      executionLeases: { none: { expiresAt: { gt: checkpointedAt } } },
    },
    data: { state: "suspending", homeRevision: revision, updatedAt: checkpointedAt },
  });
  if (recorded.count !== 1) {
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }

  const [current, activeAfterCheckpoint, backgroundAfterCheckpoint] = await Promise.all([
    deps.prisma.computer.findUnique({
      where: { id: computerId },
      select: { state: true, providerRef: true, updatedAt: true },
    }),
    findActiveRun(deps.prisma, computerId, activeStatuses),
    hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId),
  ]);
  if (activeAfterCheckpoint || backgroundAfterCheckpoint) {
    await deps.prisma.computer.updateMany({
      where: { id: computerId, state: "suspending" },
      data: { state: "running" },
    });
    scheduleComputerSleep(deps.jobs, computerId);
    if (backgroundAfterCheckpoint) await deps.sandbox.keepAlive?.(ref);
    return;
  }
  if (
    current?.state !== "suspending" ||
    current.providerRef !== computer.providerRef ||
    current.updatedAt.getTime() !== checkpointedAt.getTime()
  ) {
    await deps.prisma.computer.updateMany({
      where: { id: computerId, state: "suspending" },
      data: { state: "running" },
    });
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }

  try {
    await deps.sandbox.stop(ref, ctx);
  } catch (error) {
    await deps.prisma.computer.updateMany({
      where: { id: computerId, state: "suspending" },
      data: { state: "running" },
    });
    throw error;
  }
  await deps.prisma.computer.update({
    where: { id: computerId },
    data: {
      state: "suspended",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    },
  });
  const bots = await deps.prisma.bot.findMany({
    where: { computerId },
    select: { id: true, thread: { select: { id: true } } },
  });
  for (const bot of bots) {
    if (!bot.thread) continue;
    await deps.events.append({
      spaceId: computer.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "computer.status",
      payload: { status: "suspended" },
    });
  }
}

function loadComputer(prisma: PrismaClient, computerId: string) {
  return prisma.computer.findUnique({
    where: { id: computerId },
    select: {
      id: true,
      homeKey: true,
      providerRef: true,
      kind: true,
      state: true,
      spaceId: true,
      userId: true,
      controlHolder: true,
      controlLeaseId: true,
      controlLeaseExpiresAt: true,
      controlBotId: true,
      updatedAt: true,
    },
  });
}

function findActiveRun(prisma: PrismaClient, computerId: string, statuses: readonly string[]) {
  return prisma.run.findFirst({
    where: {
      bot: { computerId },
      status: { in: statuses as (typeof ACTIVE_RUN_STATUSES)[number][] },
    },
    select: { id: true },
  });
}

async function hasActiveBackgroundWork(
  sandbox: SandboxProvider,
  computer: ReturnType<typeof toComputerRef>,
  context: AdapterContext,
  computerId: string,
): Promise<boolean> {
  if (sandbox.inspectBackgroundWork) {
    try {
      return (await sandbox.inspectBackgroundWork(computer, computerId, context)) !== "idle";
    } catch {
      return true;
    }
  }
  let exitCode: number | undefined;
  let stdout = "";
  try {
    for await (const event of sandbox.execute(
      computer,
      {
        argv: ["bash", "-c", BACKGROUND_WORK_PROBE, "rakazo-background-probe", computerId],
        timeoutMs: 10_000,
      },
      context,
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") exitCode = event.code;
    }
  } catch {
    return true;
  }
  // Only the probe's explicit idle result permits suspension; unsupported or failed probes retry.
  return exitCode !== 1 || stdout.trim() !== BACKGROUND_WORK_IDLE_SENTINEL;
}
