import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  type ServerUpdateCheck,
  type ServerUpdateRun,
  ServerUpdateRunSchema,
  type ServerUpdateSource,
  type ServerUpdateStatus,
} from "@rakazo/contracts";
import {
  DEFAULT_UPDATE_BRANCH,
  DEFAULT_UPDATE_REMOTE,
  decideUpdateAvailability,
  detectRestartSupervisor,
  isGitCommit,
  isOfficialRepoUrl,
  normalizeRepoUrl,
  normalizeUpdateBranch,
  OFFICIAL_REPO_URL,
  parseGitStatusPorcelain,
  restartSupervisorAdvice,
  updateSteps,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  type UpdaterClient,
  UpdaterRefused,
  type UpdaterState,
  UpdaterUnreachable,
} from "./updater-client.js";

const MAX_STEP_OUTPUT = 8_000;
const STEP_TIMEOUT_MS: Record<string, number> = {
  remote: 30_000,
  fetch: 180_000,
  merge: 60_000,
  install: 900_000,
  generate: 300_000,
  build: 1_200_000,
  migrate: 300_000,
};
const DEFAULT_TIMEOUT_MS = 120_000;
const LEASE_MARGIN_MS = 60_000;
const SIDECAR_LEASE_MS = 46 * 60_000;

type ExecutionMode = "sidecar" | "checkout" | "unavailable";

function selectExecutionMode(input: {
  hasUpdater: boolean;
  hasCheckout: boolean;
  disabled: boolean;
}): { mode: ExecutionMode; reason: string | null } {
  if (input.disabled) {
    return { mode: "unavailable", reason: "Self-update is switched off for this deployment." };
  }
  if (input.hasUpdater) return { mode: "sidecar", reason: null };
  if (input.hasCheckout) return { mode: "checkout", reason: null };
  return {
    mode: "unavailable",
    reason: "This deployment has neither an updater sidecar nor a git checkout.",
  };
}

function sidecarStrategy(source: ServerUpdateSource) {
  return source.official
    ? {
        strategy: "pull" as const,
        reason:
          "Official releases are published as images, so the update is a download and restart.",
      }
    : {
        strategy: "build" as const,
        reason:
          "A fork has no published images, so the server builds this update itself. Expect minutes, not seconds.",
      };
}

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

export class SelfUpdateRefused extends Error {}

export interface SelfUpdateOptions {
  prisma: PrismaClient;
  version: string;
  /** Marker for the build that is running now, not what is on disk after an update. */
  revision: string | null;
  repoRoot: string | null;
  unsupportedReason: string | null;
  /**
   * A Compose deployment updates through this. Its container has no `.git` and nothing would
   * restart it, so the sidecar — which outlives the recreate — is the only engine that can work.
   */
  updater?: UpdaterClient | null;
  disabled?: boolean;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  exit?: () => void;
}

export interface SelfUpdateService {
  status: () => Promise<ServerUpdateStatus>;
  setSource: (input: { repoUrl: string; branch: string }) => Promise<ServerUpdateStatus>;
  check: () => Promise<ServerUpdateCheck>;
  apply: () => Promise<ServerUpdateRun>;
  rollback: () => Promise<ServerUpdateRun>;
}

/** `git` is a shell-free argv call in every case; user input never becomes part of a command line. */
const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", CI: "1" },
      },
      (error, stdout, stderr) => {
        const output = truncate(`${stdout}${stderr}`);
        if (!error) {
          resolve({ ok: true, exitCode: 0, output });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : null;
        resolve({ ok: false, exitCode, output: output || error.message });
      },
    );
  });

function truncate(value: string): string {
  const text = value.trimEnd();
  if (text.length <= MAX_STEP_OUTPUT) return text;
  return `…${text.slice(-MAX_STEP_OUTPUT)}`;
}

/**
 * A checkout the server may update has to be both a git working tree and the workspace root, so a
 * stray `.git` above a container's `/app` copy cannot be mistaken for the deployment's source.
 */
export async function resolveRepoRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 10; depth += 1) {
    const [hasGit, hasWorkspace] = await Promise.all([
      exists(path.join(dir, ".git")),
      exists(path.join(dir, "pnpm-workspace.yaml")),
    ]);
    if (hasGit && hasWorkspace) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function createSelfUpdateService(options: SelfUpdateOptions): SelfUpdateService {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const exit = options.exit ?? (() => process.exit(0));
  const supervisor = detectRestartSupervisor(env as Record<string, string | undefined>);
  const updater = options.updater ?? null;
  const execution = selectExecutionMode({
    hasUpdater: updater !== null,
    hasCheckout: options.repoRoot !== null,
    disabled: options.disabled === true,
  });
  let running = false;

  function git(args: string[], stepId = "read") {
    if (options.repoRoot === null) throw new SelfUpdateRefused(unsupportedMessage());
    return run("git", args, {
      cwd: options.repoRoot,
      timeoutMs: STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS,
    });
  }

  function unsupportedMessage(): string {
    return (
      options.unsupportedReason ??
      execution.reason ??
      "This deployment does not run from a git checkout, so it cannot update itself."
    );
  }

  /** Translates the sidecar's refusals into the same error the checkout engine raises. */
  async function throughUpdater<T>(work: (client: UpdaterClient) => Promise<T>): Promise<T> {
    if (updater === null) throw new SelfUpdateRefused(unsupportedMessage());
    try {
      return await work(updater);
    } catch (error) {
      if (error instanceof UpdaterRefused) throw new SelfUpdateRefused(error.message);
      if (error instanceof UpdaterUnreachable) throw new SelfUpdateRefused(error.message);
      throw error;
    }
  }

  async function updaterState(): Promise<UpdaterState | null> {
    if (updater === null) return null;
    return updater.state().catch(() => null);
  }

  async function readSource(): Promise<ServerUpdateSource> {
    const settings = await options.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { updateRepoUrl: true, updateBranch: true },
    });
    const stored = settings?.updateRepoUrl ? normalizeRepoUrl(settings.updateRepoUrl) : null;
    const repoUrl = stored !== null && "url" in stored ? stored.url : OFFICIAL_REPO_URL;
    const storedBranch = settings?.updateBranch
      ? normalizeUpdateBranch(settings.updateBranch)
      : null;
    const branch =
      storedBranch !== null && "branch" in storedBranch
        ? storedBranch.branch
        : DEFAULT_UPDATE_BRANCH;
    return { repoUrl, branch, official: isOfficialRepoUrl(repoUrl) };
  }

  async function readLastRun(): Promise<ServerUpdateRun | null> {
    const settings = await options.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { updateLastRun: true },
    });
    if (!settings?.updateLastRun) return null;
    try {
      const parsed = ServerUpdateRunSchema.safeParse(JSON.parse(settings.updateLastRun));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async function saveLastRun(record: ServerUpdateRun) {
    const updateLastRun = JSON.stringify(record);
    await options.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", updateLastRun },
      update: { updateLastRun },
    });
  }

  async function acquireLease(timeoutMs: number): Promise<string> {
    const now = new Date();
    const leaseId = randomUUID();
    const claimed = await options.prisma.deploymentSettings.updateMany({
      where: {
        id: "default",
        OR: [{ updateLeaseExpiresAt: null }, { updateLeaseExpiresAt: { lte: now } }],
      },
      data: {
        updateLeaseId: leaseId,
        updateLeaseExpiresAt: new Date(now.getTime() + timeoutMs + LEASE_MARGIN_MS),
      },
    });
    if (claimed.count !== 1) throw new SelfUpdateRefused("An update is already running.");
    return leaseId;
  }

  async function refreshLease(leaseId: string, timeoutMs: number): Promise<void> {
    const refreshed = await options.prisma.deploymentSettings.updateMany({
      where: { id: "default", updateLeaseId: leaseId },
      data: { updateLeaseExpiresAt: new Date(Date.now() + timeoutMs + LEASE_MARGIN_MS) },
    });
    if (refreshed.count !== 1) {
      throw new SelfUpdateRefused("The update lease was lost; no more commands were run.");
    }
  }

  async function releaseLease(leaseId: string): Promise<void> {
    await options.prisma.deploymentSettings.updateMany({
      where: { id: "default", updateLeaseId: leaseId },
      data: { updateLeaseId: null, updateLeaseExpiresAt: null },
    });
  }

  async function hasActiveLease(): Promise<boolean> {
    const settings = await options.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { updateLeaseId: true, updateLeaseExpiresAt: true },
    });
    return Boolean(
      settings?.updateLeaseId &&
        settings.updateLeaseExpiresAt &&
        settings.updateLeaseExpiresAt.getTime() > Date.now(),
    );
  }

  async function readCheckout() {
    if (options.repoRoot === null) {
      return {
        commit: null,
        branch: null,
        remoteUrl: null,
        dirty: false,
        dirtyPaths: [],
        reason: unsupportedMessage(),
      };
    }
    const [head, branch, remote, status] = await Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["remote", "get-url", DEFAULT_UPDATE_REMOTE]),
      git(["status", "--porcelain", "--untracked-files=no"]),
    ]);
    const porcelain = parseGitStatusPorcelain(status.ok ? status.output : "");
    return {
      commit: head.ok ? head.output.trim() : null,
      branch: branch.ok ? branch.output.trim() : null,
      remoteUrl: remote.ok ? remote.output.trim() : null,
      dirty: status.ok ? !porcelain.clean : false,
      dirtyPaths: porcelain.changed,
      reason: !head.ok
        ? `Could not read the checkout commit: ${head.output}`
        : !status.ok
          ? `Could not read the checkout status: ${status.output}`
          : null,
    };
  }

  async function status(): Promise<ServerUpdateStatus> {
    const [source, lastRun, sidecar, leased] = await Promise.all([
      readSource(),
      readLastRun(),
      execution.mode === "sidecar" ? updaterState() : Promise.resolve(null),
      hasActiveLease(),
    ]);
    const checkout =
      execution.mode === "sidecar"
        ? (sidecar?.checkout ?? {
            commit: null,
            branch: null,
            remoteUrl: null,
            dirty: false,
            dirtyPaths: [],
            reason: null,
          })
        : await readCheckout();
    const strategy =
      execution.mode === "sidecar" ? sidecarStrategy(source) : { strategy: null, reason: null };
    const unreachable =
      execution.mode === "sidecar" && sidecar === null
        ? "The updater sidecar is not answering. Check that the `updater` service is running in the same Compose project."
        : null;
    return {
      supported: execution.mode !== "unavailable" && unreachable === null,
      unsupportedReason:
        unreachable ?? (execution.mode === "unavailable" ? unsupportedMessage() : null),
      mode: execution.mode,
      strategy: execution.mode === "checkout" ? "checkout" : strategy.strategy,
      strategyNote: strategy.reason,
      version: options.version,
      revision: options.revision,
      commit: checkout.commit,
      branch: checkout.branch,
      remoteUrl: checkout.remoteUrl,
      dirty: checkout.dirty,
      dirtyPaths: checkout.dirtyPaths,
      image: sidecar?.image ?? null,
      imageTag: sidecar?.currentTag ?? null,
      previousImageTag: sidecar?.previousTag ?? null,
      canRollback: sidecar !== null && sidecar.previousTag !== null,
      source,
      officialRepoUrl: OFFICIAL_REPO_URL,
      restartSupervisor: supervisor.kind,
      restartAdvice: restartAdviceFor(execution.mode, supervisor),
      running: running || leased || sidecar?.running === true,
      lastRun,
    };
  }

  async function setSource(input: { repoUrl: string; branch: string }) {
    const url = normalizeRepoUrl(input.repoUrl);
    if ("error" in url) throw new SelfUpdateRefused(url.error);
    const branch = normalizeUpdateBranch(input.branch);
    if ("error" in branch) throw new SelfUpdateRefused(branch.error);
    const now = new Date();
    const changed = await options.prisma.deploymentSettings.updateMany({
      where: {
        id: "default",
        OR: [{ updateLeaseExpiresAt: null }, { updateLeaseExpiresAt: { lte: now } }],
      },
      data: { updateRepoUrl: url.url, updateBranch: branch.branch },
    });
    if (changed.count !== 1) {
      throw new SelfUpdateRefused("Wait for the running update before changing its source.");
    }
    return status();
  }

  async function check(): Promise<ServerUpdateCheck> {
    const empty = { reason: null, changed: [], commit: null, targetCommit: null, behindBy: 0 };
    if (execution.mode === "unavailable" || options.repoRoot === null) {
      if (execution.mode !== "sidecar") {
        return { ...empty, status: "unavailable", reason: unsupportedMessage() };
      }
    }
    // A fetch updates git metadata (including FETCH_HEAD), so checks share the same deployment-wide
    // lease as apply. This prevents two API replicas, or a check racing an apply, from operating on
    // the checkout at the same time.
    const leaseId = await acquireLease(STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS);
    try {
      if (execution.mode === "sidecar") return await checkThroughUpdater(empty);
      const source = await readSource();
      return await checkCheckout(source, empty);
    } finally {
      await releaseLease(leaseId).catch(() => undefined);
    }
  }

  async function checkCheckout(
    source: ServerUpdateSource,
    empty: {
      reason: null;
      changed: never[];
      commit: null;
      targetCommit: null;
      behindBy: number;
    } = { reason: null, changed: [], commit: null, targetCommit: null, behindBy: 0 },
  ): Promise<ServerUpdateCheck> {
    const checkout = await readCheckout();
    if (checkout.reason) {
      return {
        ...empty,
        status: "unavailable",
        reason: checkout.reason,
        commit: checkout.commit,
      };
    }
    if (checkout.dirty) {
      return {
        ...empty,
        status: "dirty",
        changed: checkout.dirtyPaths,
        commit: checkout.commit,
        reason:
          "The checkout has uncommitted changes to tracked files. Commit, stash, or discard them before updating.",
      };
    }
    // Always use the exact owner-selected transport. Identity equality is not enough here: changing
    // the same repository from an inaccessible SSH URL to working HTTPS must stop using origin.
    const fetched = await git(
      ["fetch", "--no-tags", "--prune", source.repoUrl, source.branch],
      "fetch",
    );
    if (!fetched.ok) {
      return {
        ...empty,
        status: "unavailable",
        reason: `Could not fetch ${source.repoUrl}: ${fetched.output}`,
        commit: checkout.commit,
      };
    }
    const target = await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    const targetCommit = target.ok ? target.output.trim() : "";
    if (!isGitCommit(targetCommit)) {
      return {
        ...empty,
        status: "unavailable",
        reason: "The selected branch did not resolve to a full git commit digest.",
        commit: checkout.commit,
      };
    }
    const ancestor = await git(["merge-base", "--is-ancestor", "HEAD", targetCommit]);
    if (!ancestor.ok) {
      return {
        ...empty,
        status: "unavailable",
        reason:
          "The selected commit is not a fast-forward from this checkout. Choose a branch that contains the running commit; self-update never rewrites local history.",
        commit: checkout.commit,
        targetCommit,
      };
    }
    const counts = await git(["rev-list", "--count", `HEAD..${targetCommit}`]);
    const decision = decideUpdateAvailability({
      commit: checkout.commit ?? undefined,
      targetCommit,
      behindBy: counts.ok ? Number.parseInt(counts.output.trim(), 10) || 0 : 0,
      status: { clean: !checkout.dirty, changed: checkout.dirtyPaths },
    });
    if (decision.status === "unavailable") {
      return { ...empty, status: "unavailable", reason: decision.reason };
    }
    if (decision.status === "dirty") throw new Error("Dirty checkout escaped preflight.");
    if (decision.status === "up-to-date") {
      return { ...empty, status: "up-to-date", commit: decision.commit };
    }
    return {
      ...empty,
      status: "available",
      commit: decision.commit,
      targetCommit: decision.targetCommit,
      behindBy: decision.behindBy,
    };
  }

  /**
   * The sidecar owns the real decision, so this only reshapes its plan into the check the UI
   * already renders. A fork's plan reports commits; the official path reports image tags.
   */
  async function checkThroughUpdater(empty: {
    reason: null;
    changed: never[];
    commit: null;
    targetCommit: null;
    behindBy: number;
  }): Promise<ServerUpdateCheck> {
    const source = await readSource();
    try {
      const plan = await throughUpdater((client) => client.plan(source));
      if (plan.strategy === "build" && plan.checkout.dirty) {
        return {
          ...empty,
          status: "dirty",
          changed: plan.checkout.dirtyPaths,
          commit: plan.checkout.commit,
          reason:
            "The deployment checkout has uncommitted changes to tracked files. Commit, stash, or discard them before updating.",
        };
      }
      if (plan.upToDate) {
        return { ...empty, status: "up-to-date", commit: plan.checkout.commit };
      }
      return {
        ...empty,
        status: "available",
        commit: plan.checkout.commit,
        targetCommit: plan.targetCommit,
        reason: plan.targetTag === null ? plan.reason : `${plan.targetTag}. ${plan.reason}`,
      };
    } catch (error) {
      if (error instanceof SelfUpdateRefused) {
        return { ...empty, status: "unavailable", reason: error.message };
      }
      throw error;
    }
  }

  async function apply(): Promise<ServerUpdateRun> {
    if (execution.mode === "unavailable") throw new SelfUpdateRefused(unsupportedMessage());
    const leaseId = await acquireLease(
      execution.mode === "sidecar"
        ? SIDECAR_LEASE_MS
        : (STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS),
    );
    running = true;
    try {
      if (execution.mode === "sidecar") {
        const source = await readSource();
        const record = await throughUpdater((client) => client.apply(source));
        await saveLastRun(record);
        return record;
      }
      if (options.repoRoot === null) throw new SelfUpdateRefused(unsupportedMessage());
      return await applyCheckout(leaseId);
    } finally {
      running = false;
      await releaseLease(leaseId).catch(() => undefined);
    }
  }

  async function applyCheckout(leaseId: string): Promise<ServerUpdateRun> {
    if (options.repoRoot === null) throw new SelfUpdateRefused(unsupportedMessage());
    const source = await readSource();
    const preflight = await checkCheckout(source);
    if (preflight.status === "unavailable" || preflight.status === "dirty") {
      throw new SelfUpdateRefused(preflight.reason ?? "This deployment cannot be updated.");
    }

    const checkout = await readCheckout();
    if (checkout.reason || checkout.dirty || checkout.commit !== preflight.commit) {
      throw new SelfUpdateRefused(
        "The checkout changed during preflight. No update commands were run; check again.",
      );
    }
    const currentRemote = checkout.remoteUrl === null ? null : normalizeRepoUrl(checkout.remoteUrl);
    const repointRemote =
      currentRemote === null || "error" in currentRemote || currentRemote.url !== source.repoUrl;
    const startedAt = new Date().toISOString();
    if (preflight.status === "up-to-date") {
      const record: ServerUpdateRun = {
        startedAt,
        finishedAt: repointRemote ? null : new Date().toISOString(),
        ok: !repointRemote,
        fromCommit: preflight.commit,
        toCommit: preflight.commit,
        fromTag: null,
        toTag: null,
        strategy: "checkout",
        repoUrl: source.repoUrl,
        branch: source.branch,
        restart: "not-required",
        restartAdvice: "Already on the latest commit; no code or database changes were required.",
        error: null,
        steps: [],
      };
      await saveLastRun(record);
      if (repointRemote) {
        const timeoutMs = STEP_TIMEOUT_MS.remote ?? DEFAULT_TIMEOUT_MS;
        await refreshLease(leaseId, timeoutMs);
        const result = await run(
          "git",
          ["remote", "set-url", DEFAULT_UPDATE_REMOTE, source.repoUrl],
          { cwd: options.repoRoot, timeoutMs },
        );
        const label = "Point origin at the selected repository";
        record.steps.push({
          id: "remote",
          label,
          ok: result.ok,
          exitCode: result.exitCode,
          output: result.output,
        });
        record.ok = result.ok;
        record.error = result.ok ? null : `${label} failed.`;
        record.restartAdvice = result.ok
          ? "Already on the latest commit; origin now tracks the selected repository. No restart was required."
          : `${record.error} No code or database changes were made; nothing was restarted.`;
        record.finishedAt = new Date().toISOString();
        await saveLastRun(record);
      }
      return record;
    }
    if (preflight.targetCommit === null) {
      throw new SelfUpdateRefused("The selected repository did not return an update commit.");
    }

    const steps = updateSteps({
      remoteUrl: source.repoUrl,
      branch: source.branch,
      targetCommit: preflight.targetCommit,
      repointRemote,
    });
    const record: ServerUpdateRun = {
      startedAt,
      finishedAt: null,
      ok: false,
      fromCommit: checkout.commit,
      toCommit: null,
      fromTag: null,
      toTag: null,
      strategy: "checkout",
      repoUrl: source.repoUrl,
      branch: source.branch,
      restart: "manual",
      restartAdvice: restartSupervisorAdvice(supervisor),
      error: null,
      steps: [],
    };

    // Persist before the first mutation and after every step. A process killed half way through
    // leaves a durable unfinished record instead of making the previous success look current.
    await saveLastRun(record);
    for (const step of steps) {
      const timeoutMs = STEP_TIMEOUT_MS[step.id] ?? DEFAULT_TIMEOUT_MS;
      await refreshLease(leaseId, timeoutMs);
      const result = await run(step.command, step.args, { cwd: options.repoRoot, timeoutMs });
      record.steps.push({
        id: step.id,
        label: step.label,
        ok: result.ok,
        exitCode: result.exitCode,
        output: result.output,
      });
      if (!result.ok) record.error = `${step.label} failed.`;
      await saveLastRun(record);
      if (!result.ok) break;
    }

    const head = await git(["rev-parse", "HEAD"]);
    record.toCommit = head.ok && isGitCommit(head.output.trim()) ? head.output.trim() : null;
    if (record.error === null && record.toCommit !== preflight.targetCommit) {
      record.error = "The checkout did not finish on the commit selected by preflight.";
    }
    record.ok = record.error === null;
    if (record.ok && supervisor.kind !== "none") record.restart = "supervised";
    if (!record.ok) {
      record.restartAdvice = `${record.error} The checkout may be partly updated. Read the step output, fix the cause, then run the update again. Nothing was restarted.`;
    }
    record.finishedAt = new Date().toISOString();
    await saveLastRun(record);

    if (record.restart === "supervised") {
      // Answer the caller before the process goes away, otherwise the operator watches the socket
      // die instead of reading the result.
      setTimeout(exit, 1_500);
    }
    return record;
  }

  async function rollback(): Promise<ServerUpdateRun> {
    if (execution.mode !== "sidecar") {
      throw new SelfUpdateRefused(
        "Rollback needs the updater sidecar, which redeploys the previously running image tag. On a source checkout, `git checkout` the previous commit and restart instead.",
      );
    }
    const leaseId = await acquireLease(SIDECAR_LEASE_MS);
    running = true;
    try {
      const record = await throughUpdater((client) => client.rollback());
      await saveLastRun(record);
      return record;
    } finally {
      running = false;
      await releaseLease(leaseId).catch(() => undefined);
    }
  }

  return { status, setSource, check, apply, rollback };
}

/**
 * Only the checkout engine ever exits and waits to be restarted. On the sidecar path the updater
 * recreates the containers itself, so supervisor detection is not part of the answer at all.
 */
function restartAdviceFor(
  mode: ExecutionMode,
  supervisor: ReturnType<typeof detectRestartSupervisor>,
): string {
  if (mode === "sidecar") {
    return "The updater sidecar recreates the API, worker, and web containers, so nothing here has to restart itself and no process supervisor is required.";
  }
  if (mode === "unavailable") return "Updates are unavailable on this deployment.";
  return restartSupervisorAdvice(supervisor);
}
