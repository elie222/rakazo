import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  computerSleepJob,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { expireComputerControl, hasActiveComputerControl } from "./computer-control.js";
import { toComputerRef } from "./computer-lifecycle.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

export const DEFAULT_SANDBOX_IDLE_MS = 10 * 60 * 1000;
/**
 * Default uptime cap for providers that bill while running. Background work and viewers
 * do not extend it; executing runs and active user control leases defer suspension.
 * COMPUTER_MAX_ACTIVE_MS configures the limit; 0 disables it.
 */
export const DEFAULT_COMPUTER_MAX_ACTIVE_MS = 2 * 60 * 60 * 1000;
/**
 * How long a run waiting for takeover keeps a computer that does not bill while running awake
 * after asking, so the user can answer the push and finish a login, Duo, or CAPTCHA step on the
 * same open page. Billed computers get no grace: an ignored request would keep them running.
 */
export const TAKEOVER_IDLE_GRACE_MS = 30 * 60 * 1000;
const EXECUTING_RUN_STATUSES = ["leased", "running"] as const;
const BACKGROUND_WORK_MARKER_PREFIX = "/tmp/rakazo-background-";
const BACKGROUND_WORK_IDLE_SENTINEL = "rakazo-background-idle";

export const BACKGROUND_WORK_LAUNCH = [
  `marker="${BACKGROUND_WORK_MARKER_PREFIX}$1-$2-$3"`,
  "set -o noclobber",
  'exec 9>"$marker" || exit 1',
  "set +o noclobber",
  'exec bash -lc "$4"',
].join("\n");

// Unobservable proc entries are skipped; unexpected errors invalidate the whole scan.
const LINUX_BACKGROUND_HOLDERS = [
  "linux_background_holders() {",
  '  python3 - "$prefix" "$@" <<\'PY\'',
  "import errno",
  "import os",
  "import sys",
  "",
  "prefix = sys.argv[1]",
  "unobservable = {errno.ENOENT, errno.ESRCH, errno.EACCES, errno.EPERM}",
  "holders = set()",
  "",
  "def inspect(pid):",
  "    try:",
  '        with os.scandir("/proc/" + pid + "/fd") as entries:',
  "            for entry in entries:",
  "                if not entry.name.isascii() or not entry.name.isdigit():",
  "                    continue",
  "                try:",
  "                    target = os.readlink(entry.path)",
  "                except OSError as error:",
  "                    if error.errno in unobservable:",
  "                        continue",
  "                    raise",
  "                if target.startswith(prefix):",
  "                    holders.add(int(pid))",
  "    except OSError as error:",
  "        if error.errno not in unobservable:",
  "            raise",
  "",
  "try:",
  '    if not os.access("/proc", os.R_OK | os.X_OK):',
  "        sys.exit(2)",
  "    if len(sys.argv) > 2:",
  "        pid = sys.argv[2]",
  "        if not pid.isascii() or not pid.isdigit() or int(pid) <= 0:",
  "            sys.exit(2)",
  "        inspect(pid)",
  "    else:",
  '        with os.scandir("/proc") as entries:',
  "            for entry in entries:",
  "                if entry.name.isascii() and entry.name.isdigit() and int(entry.name) > 0:",
  "                    inspect(entry.name)",
  "except OSError:",
  "    sys.exit(2)",
  "",
  "for pid in sorted(holders):",
  "    print(pid)",
  "PY",
  "}",
].join("\n");

/** Terminate background shell wrappers for one cancelled run. Browser teardown stays screen-scoped. */
export const CANCEL_COMPUTER_RUN_WORK = [
  'computerId="$1"',
  'runId="$2"',
  '[ -n "$computerId" ] && [ -n "$runId" ] || exit 0',
  `prefix="${BACKGROUND_WORK_MARKER_PREFIX}$computerId-$runId-"`,
  LINUX_BACKGROUND_HOLDERS,
  "if [ -d /proc ]; then",
  '  holders="$(linux_background_holders)" || holders=""',
  "  for pid in $holders; do",
  '    current="$(linux_background_holders "$pid")" || continue',
  '    [ "$current" = "$pid" ] && kill -TERM "$pid" 2>/dev/null || true',
  "  done",
  "  sleep 0.2",
  '  holders="$(linux_background_holders)" || holders=""',
  "  for pid in $holders; do",
  '    current="$(linux_background_holders "$pid")" || continue',
  // Never signal a process group. Sandbox work can share the caller's PGID.
  '    [ "$current" = "$pid" ] && kill -KILL "$pid" 2>/dev/null || true',
  "  done",
  '  markers=("$prefix"*)',
  '  if holders="$(linux_background_holders)" && [ -z "$holders" ]; then',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  '    for marker in "${markers[@]}"; do rm -f -- "$marker" 2>/dev/null || true; done',
  "  fi",
  "  exit 0",
  'elif [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
  `  pkill -TERM -f "rakazo-background-launch $computerId $runId " 2>/dev/null || true`,
  '  for marker in "$prefix"*; do',
  '    [ -e "$marker" ] || continue',
  '    for pid in $(lsof -t -- "$marker" 2>/dev/null); do',
  '      kill -TERM "$pid" 2>/dev/null || true',
  "    done",
  "  done",
  "else",
  "  exit 0",
  "fi",
  "sleep 0.2",
  `pkill -KILL -f "rakazo-background-launch $computerId $runId " 2>/dev/null || true`,
  'if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v lsof >/dev/null 2>&1; then',
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
  `      kill -TERM "\${pid#/proc/}" 2>/dev/null || true`,
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
  `      kill -KILL "\${pid#/proc/}" 2>/dev/null || true`,
  "      ;;",
  "  esac",
  "done; fi",
  'rm -f "$HOME/.browser-profiles/chromium/SingletonLock" "$HOME/.browser-profiles/chromium/SingletonCookie" "$HOME/.browser-profiles/chromium/SingletonSocket" 2>/dev/null || true',
].join("; ");

export function cancelComputerRunWorkArgv(computerId: string, runId: string): string[] {
  return ["bash", "-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId];
}

export async function cancelComputerRunWork(
  sandbox: Pick<SandboxProvider, "execute" | "cancelRunWork">,
  computer: ComputerRef,
  computerId: string,
  runId: string,
  context: AdapterContext,
): Promise<void> {
  if (!computerId || !runId) return;
  try {
    if (sandbox.cancelRunWork) {
      await sandbox.cancelRunWork(computer, computerId, runId, context);
      return;
    }
    if (computer.kind === "desktop") return;

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
  LINUX_BACKGROUND_HOLDERS,
  'markers=("$prefix"*)',
  "if [ -d /proc ]; then",
  '  holders="$(linux_background_holders)" || exit 2',
  '  [ -n "$holders" ] && exit 0',
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

export function computerMaxActiveMs(): number {
  const raw = Number(process.env.COMPUTER_MAX_ACTIVE_MS?.trim() || DEFAULT_COMPUTER_MAX_ACTIVE_MS);
  return Number.isFinite(raw) && (raw === 0 || raw >= 60_000)
    ? raw
    : DEFAULT_COMPUTER_MAX_ACTIVE_MS;
}

export function computerIdleSleepEnabled(): boolean {
  return process.env.SANDBOX_IDLE_MS?.trim() !== "0";
}

export function scheduleComputerSleep(
  jobs: JobPublisher,
  computerId: string,
  notAfter?: Date,
): void {
  if (!computerId || !computerIdleSleepEnabled()) return;
  const at = Date.now() + sandboxIdleMs();
  void jobs.enqueue(
    computerSleepJob(computerId, new Date(notAfter ? Math.min(at, notAfter.getTime()) : at)),
  );
}

function activeLimitReached(
  sandbox: SandboxProvider,
  ref: ComputerRef,
  runningSince: Date | null | undefined,
): boolean {
  const limit = computerMaxActiveMs();
  return (
    limit > 0 &&
    sandbox.billsWhileRunning?.(ref) === true &&
    runningSince != null &&
    Date.now() - runningSince.getTime() >= limit
  );
}

export async function touchRunningComputer(
  deps: { sandbox: SandboxProvider; jobs: JobPublisher },
  computer: {
    id: string;
    homeKey: string;
    providerRef: string;
    kind: string;
    runningSince?: Date | null;
    controlHolder?: string;
    controlLeaseId?: string | null;
    controlLeaseExpiresAt?: Date | null;
  },
): Promise<void> {
  const activeControl = hasActiveComputerControl({
    controlHolder: computer.controlHolder ?? "none",
    controlLeaseId: computer.controlLeaseId ?? null,
    controlLeaseExpiresAt: computer.controlLeaseExpiresAt ?? null,
  });
  if (
    activeLimitReached(deps.sandbox, toComputerRef(computer), computer.runningSince) &&
    !activeControl
  ) {
    if (computerIdleSleepEnabled()) {
      void deps.jobs.enqueue(computerSleepJob(computer.id, new Date(Date.now())));
    }
    return;
  }
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
  if (!computerIdleSleepEnabled()) return;
  let computer = await loadComputer(deps.prisma, computerId);
  if (!computer?.providerRef || computer.state !== "running") return;
  // Native computers have no provisioned runtime to suspend; Electron owns their lifetime.
  if (computer.kind === "desktop") return;

  if (computer.controlBotId && computer.controlLeaseId && !hasActiveComputerControl(computer)) {
    await expireComputerControl(deps, computer.id, computer.controlLeaseId);
    computer = await loadComputer(deps.prisma, computerId);
    if (!computer?.providerRef || computer.state !== "running") return;
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
  // Past the lifetime limit only a run executing right now holds the computer up; waiting
  // runs and background work start it again when they next need it. A user in control is
  // left alone: control leases expire on their own, and that release resumes the waiting run.
  // Otherwise a run waiting for takeover holds an unbilled computer for TAKEOVER_IDLE_GRACE_MS.
  const activeControl = hasActiveComputerControl(computer);
  const limitReached =
    activeLimitReached(deps.sandbox, ref, computer.runningSince) && !activeControl;
  const activeStatuses = limitReached
    ? EXECUTING_RUN_STATUSES
    : activeControl
      ? [...ACTIVE_RUN_STATUSES]
      : ACTIVE_RUN_STATUSES.filter((status) => status !== "waiting_takeover");
  const runHolds = () => findActiveRun(deps.prisma, computerId, activeStatuses, limitReached);
  const backgroundHolds = () =>
    limitReached
      ? Promise.resolve(false)
      : hasActiveBackgroundWork(deps.sandbox, ref, ctx, computerId);
  const graceEndsAt = () =>
    activeControl || deps.sandbox.billsWhileRunning?.(ref) === true
      ? Promise.resolve(null)
      : takeoverGraceEndsAt(deps.prisma, computerId);
  const runHeld = Boolean(await runHolds());
  const takeoverHeldUntil = runHeld ? null : await graceEndsAt();
  if (runHeld || takeoverHeldUntil || (await backgroundHolds())) {
    // Recheck when the takeover grace ends so the computer sleeps on time.
    scheduleComputerSleep(deps.jobs, computerId, takeoverHeldUntil ?? undefined);
    try {
      await deps.sandbox.keepAlive?.(ref);
    } catch (error) {
      // The holding run or the next idle check recovers a computer whose sandbox is gone.
      if (!isSandboxGoneError(error)) throw error;
    }
    return;
  }

  const checkpointedAt = new Date();
  const recorded = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: "running",
      maintenanceId: null,
      providerRef: computer.providerRef,
      updatedAt: computer.updatedAt,
      executionRunId: null,
      executionLeases: { none: { expiresAt: { gt: checkpointedAt } } },
    },
    data: { state: "suspending", updatedAt: checkpointedAt },
  });
  if (recorded.count !== 1) {
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }
  const suspensionClaim = {
    id: computerId,
    state: "suspending",
    providerRef: computer.providerRef,
    updatedAt: checkpointedAt,
  };

  try {
    const revision = await checkpointComputerWorkspace(
      deps.home,
      deps.sandbox,
      computer.homeKey,
      ref,
      ctx,
    );
    const saved = await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { homeRevision: revision, homeRevisionAt: checkpointedAt, updatedAt: checkpointedAt },
    });
    if (saved.count !== 1) {
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: { state: "running" },
      });
      scheduleComputerSleep(deps.jobs, computerId);
      return;
    }
  } catch (error) {
    if (isSandboxGoneError(error)) {
      // Nothing is left to checkpoint or stop. Retrying would fail the same way every idle
      // window, so clear the dead ref and let the next use boot from the last saved revision.
      await deps.prisma.computer.updateMany({
        where: suspensionClaim,
        data: {
          state: "stopped",
          providerRef: null,
          runningSince: null,
          controlHolder: "none",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
          controlRunId: null,
        },
      });
      return;
    }
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { state: "running" },
    });
    scheduleComputerSleep(deps.jobs, computerId);
    // A sandbox too busy or stuck to answer cannot be checkpointed now; the next idle check
    // tries again instead of reporting the same timeout every window. One the provider can only
    // bring back from its own snapshot waits for the next use, which restores a newer save.
    if (error instanceof SandboxUnresponsiveError || error instanceof SandboxUnavailableError) {
      getLogger().warn("computer.sleep_deferred", {
        "computer.id": computerId,
        provider: computer.kind,
        reason: error instanceof SandboxUnresponsiveError ? "unresponsive" : "unavailable",
      });
      return;
    }
    throw error;
  }

  const [current, activeAfterCheckpoint, takeoverAfterCheckpoint, backgroundAfterCheckpoint] =
    await Promise.all([
      deps.prisma.computer.findUnique({
        where: { id: computerId },
        select: { state: true, providerRef: true, updatedAt: true },
      }),
      runHolds(),
      graceEndsAt(),
      backgroundHolds(),
    ]);
  if (activeAfterCheckpoint || takeoverAfterCheckpoint || backgroundAfterCheckpoint) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { state: "running" },
    });
    scheduleComputerSleep(
      deps.jobs,
      computerId,
      activeAfterCheckpoint ? undefined : (takeoverAfterCheckpoint ?? undefined),
    );
    if (backgroundAfterCheckpoint) await deps.sandbox.keepAlive?.(ref);
    return;
  }
  if (
    current?.state !== "suspending" ||
    current.providerRef !== computer.providerRef ||
    current.updatedAt.getTime() !== checkpointedAt.getTime()
  ) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { state: "running" },
    });
    scheduleComputerSleep(deps.jobs, computerId);
    return;
  }

  try {
    await deps.sandbox.stop(ref, ctx);
  } catch (error) {
    await deps.prisma.computer.updateMany({
      where: suspensionClaim,
      data: { state: "running" },
    });
    throw error;
  }
  const suspended = await deps.prisma.computer.updateMany({
    where: suspensionClaim,
    data: {
      state: "suspended",
      runningSince: null,
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
    },
  });
  if (suspended.count !== 1) {
    // A Reset, a stale-claim recovery, or a deletion took the computer while it stopped. The
    // new owner restarts it from the saved revision; there is nothing left for this job to do.
    getLogger().warn("computer.suspend_superseded", { "computer.id": computerId });
    return;
  }
  getLogger().info("computer.suspended", {
    "computer.id": computerId,
    provider: computer.kind,
    reason: limitReached ? "active_limit" : "idle",
    activeMs: computer.runningSince ? Date.now() - computer.runningSince.getTime() : undefined,
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
      runningSince: true,
      updatedAt: true,
    },
  });
}

function findActiveRun(
  prisma: PrismaClient,
  computerId: string,
  statuses: readonly string[],
  liveLeaseOnly = false,
) {
  return prisma.run.findFirst({
    where: {
      bot: { computerId },
      status: { in: statuses as (typeof ACTIVE_RUN_STATUSES)[number][] },
      ...(liveLeaseOnly ? { leaseExpiresAt: { gt: new Date(Date.now()) } } : {}),
    },
    select: { id: true },
  });
}

/** When the newest takeover request of a run still waiting on this computer stops holding it. */
async function takeoverGraceEndsAt(prisma: PrismaClient, computerId: string): Promise<Date | null> {
  const waiting = await prisma.run.findMany({
    where: { bot: { computerId }, status: "waiting_takeover" },
    select: { id: true },
  });
  if (waiting.length === 0) return null;
  const requested = await prisma.event.findFirst({
    where: {
      runId: { in: waiting.map((run) => run.id) },
      type: "computer.takeover.requested",
      createdAt: { gt: new Date(Date.now() - TAKEOVER_IDLE_GRACE_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return requested ? new Date(requested.createdAt.getTime() + TAKEOVER_IDLE_GRACE_MS) : null;
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
    } catch (error) {
      // A gone sandbox runs nothing; the checkpoint below then stops the computer.
      return !isSandboxGoneError(error);
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
  } catch (error) {
    return !isSandboxGoneError(error);
  }
  // Only the probe's explicit idle result permits suspension; unsupported or failed probes retry.
  return exitCode !== 1 || stdout.trim() !== BACKGROUND_WORK_IDLE_SENTINEL;
}
