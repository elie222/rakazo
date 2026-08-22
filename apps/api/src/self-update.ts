import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type {
  ServerUpdateCheck,
  ServerUpdateRun,
  ServerUpdateSource,
  ServerUpdateStatus,
} from "@rakazo/contracts";
import {
  chooseUpdateStrategy,
  DEFAULT_UPDATE_BRANCH,
  DEFAULT_UPDATE_REMOTE,
  decideUpdateAvailability,
  detectRestartSupervisor,
  isOfficialRepoUrl,
  normalizeRepoUrl,
  normalizeUpdateBranch,
  OFFICIAL_REPO_URL,
  parseGitStatusPorcelain,
  repoIdentity,
  resolveExecutionMode,
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
  checkout: 60_000,
  merge: 60_000,
  install: 900_000,
  generate: 300_000,
  build: 1_200_000,
  migrate: 300_000,
};
const DEFAULT_TIMEOUT_MS = 120_000;

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
  const execution = resolveExecutionMode({
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
      return JSON.parse(settings.updateLastRun) as ServerUpdateRun;
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

  async function readCheckout() {
    if (options.repoRoot === null) {
      return { commit: null, branch: null, remoteUrl: null, dirty: false, dirtyPaths: [] };
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
    };
  }

  async function status(): Promise<ServerUpdateStatus> {
    const [source, lastRun, sidecar] = await Promise.all([
      readSource(),
      readLastRun(),
      execution.mode === "sidecar" ? updaterState() : Promise.resolve(null),
    ]);
    const checkout =
      execution.mode === "sidecar"
        ? (sidecar?.checkout ?? {
            commit: null,
            branch: null,
            remoteUrl: null,
            dirty: false,
            dirtyPaths: [],
          })
        : await readCheckout();
    const strategy =
      execution.mode === "sidecar"
        ? chooseUpdateStrategy(source)
        : { strategy: null, reason: null };
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
      running: running || sidecar?.running === true,
      lastRun,
    };
  }

  async function setSource(input: { repoUrl: string; branch: string }) {
    const url = normalizeRepoUrl(input.repoUrl);
    if ("error" in url) throw new SelfUpdateRefused(url.error);
    const branch = normalizeUpdateBranch(input.branch);
    if ("error" in branch) throw new SelfUpdateRefused(branch.error);
    await options.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", updateRepoUrl: url.url, updateBranch: branch.branch },
      update: { updateRepoUrl: url.url, updateBranch: branch.branch },
    });
    return status();
  }

  async function check(): Promise<ServerUpdateCheck> {
    const empty = { reason: null, changed: [], commit: null, targetCommit: null, behindBy: 0 };
    if (execution.mode === "sidecar") return checkThroughUpdater(empty);
    if (execution.mode === "unavailable" || options.repoRoot === null) {
      return { ...empty, status: "unavailable", reason: unsupportedMessage() };
    }
    const source = await readSource();
    const checkout = await readCheckout();
    const fetched = await git(["fetch", "--prune", DEFAULT_UPDATE_REMOTE, source.branch], "fetch");
    if (!fetched.ok) {
      return {
        ...empty,
        status: "unavailable",
        reason: `Could not fetch ${source.repoUrl}: ${fetched.output}`,
        commit: checkout.commit,
      };
    }
    const target = await git(["rev-parse", `${DEFAULT_UPDATE_REMOTE}/${source.branch}`]);
    const counts = await git([
      "rev-list",
      "--count",
      `HEAD..${DEFAULT_UPDATE_REMOTE}/${source.branch}`,
    ]);
    const decision = decideUpdateAvailability({
      commit: checkout.commit ?? undefined,
      targetCommit: target.ok ? target.output.trim() : undefined,
      behindBy: counts.ok ? Number.parseInt(counts.output.trim(), 10) || 0 : 0,
      status: { clean: !checkout.dirty, changed: checkout.dirtyPaths },
    });
    if (decision.status === "unavailable") {
      return { ...empty, status: "unavailable", reason: decision.reason };
    }
    if (decision.status === "dirty") {
      return {
        ...empty,
        status: "dirty",
        changed: decision.changed,
        commit: checkout.commit,
        reason:
          "The checkout has uncommitted changes to tracked files. Commit, stash, or discard them before updating.",
      };
    }
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
    if (execution.mode === "sidecar") {
      const source = await readSource();
      const record = await throughUpdater((client) => client.apply(source));
      await saveLastRun(record).catch(() => undefined);
      return record;
    }
    if (execution.mode === "unavailable" || options.repoRoot === null) {
      throw new SelfUpdateRefused(unsupportedMessage());
    }
    if (running) throw new SelfUpdateRefused("An update is already running.");

    const source = await readSource();
    const preflight = await check();
    if (preflight.status === "unavailable" || preflight.status === "dirty") {
      throw new SelfUpdateRefused(preflight.reason ?? "This deployment cannot be updated.");
    }

    const startedAt = new Date().toISOString();
    if (preflight.status === "up-to-date") {
      const record: ServerUpdateRun = {
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: true,
        fromCommit: preflight.commit,
        toCommit: preflight.commit,
        fromTag: null,
        toTag: null,
        strategy: "checkout",
        repoUrl: source.repoUrl,
        branch: source.branch,
        restart: "not-required",
        restartAdvice: "Already on the latest commit; nothing was changed.",
        error: null,
        steps: [],
      };
      await saveLastRun(record);
      return record;
    }

    running = true;
    const checkout = await readCheckout();
    const currentIdentity = checkout.remoteUrl === null ? null : repoIdentity(checkout.remoteUrl);
    const steps = updateSteps({
      remoteUrl: source.repoUrl,
      branch: source.branch,
      repointRemote: currentIdentity !== repoIdentity(source.repoUrl),
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

    try {
      for (const step of steps) {
        const result = await run(step.command, step.args, {
          cwd: options.repoRoot,
          timeoutMs: STEP_TIMEOUT_MS[step.id] ?? DEFAULT_TIMEOUT_MS,
        });
        record.steps.push({
          id: step.id,
          label: step.label,
          ok: result.ok,
          exitCode: result.exitCode,
          output: result.output,
        });
        if (!result.ok) {
          record.error = `${step.label} failed.`;
          break;
        }
      }
      const head = await git(["rev-parse", "HEAD"]);
      record.toCommit = head.ok ? head.output.trim() : null;
      record.ok = record.error === null;
      if (record.ok && supervisor.kind !== "none") record.restart = "supervised";
      if (!record.ok) {
        record.restartAdvice = `${record.error} The checkout may be partly updated. Read the step output, fix the cause, then run the update again. Nothing was restarted.`;
      }
      record.finishedAt = new Date().toISOString();
      await saveLastRun(record).catch(() => undefined);
    } finally {
      running = false;
    }

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
    const record = await throughUpdater((client) => client.rollback());
    await saveLastRun(record).catch(() => undefined);
    return record;
  }

  return { status, setSource, check, apply, rollback };
}

/**
 * Only the checkout engine ever exits and waits to be restarted. On the sidecar path the updater
 * recreates the containers itself, so supervisor detection is not part of the answer at all.
 */
function restartAdviceFor(
  mode: ReturnType<typeof resolveExecutionMode>["mode"],
  supervisor: ReturnType<typeof detectRestartSupervisor>,
): string {
  if (mode === "sidecar") {
    return "The updater sidecar recreates the API, worker, and web containers, so nothing here has to restart itself and no process supervisor is required.";
  }
  if (mode === "unavailable") return "Updates are unavailable on this deployment.";
  return restartSupervisorAdvice(supervisor);
}
