import { execFile } from "node:child_process";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { ServerUpdateRun } from "@rakazo/contracts";
import {
  type ComposeUpdateStep,
  chooseUpdateStrategy,
  composeUpdatePlan,
  DEFAULT_UPDATE_REMOTE,
  forkImageTag,
  gitIndexContentDiffArgv,
  gitStatusArgv,
  gitWorktreeContentDiffArgv,
  hasValidBearerToken,
  IMAGE_TAG_ENV,
  imageRef,
  isLocalImageTag,
  PREVIOUS_IMAGE_TAG_ENV,
  parseGitNameOnly,
  parseGitStatusPorcelain,
  parseLsRemoteTags,
  repoIdentity,
  resolveTrackedDirtyPaths,
  rollbackTarget,
  selectLatestReleaseTag,
  upsertEnvAssignments,
  validateUpdateRequest,
} from "@rakazo/core";
import { type Context, Hono } from "hono";
import {
  readTagState,
  resolveUpdaterConfig,
  truncateOutput,
  UpdateRefused,
  type UpdaterConfig,
} from "./updater-logic.js";

const STEP_TIMEOUT_MS: Record<string, number> = {
  remote: 30_000,
  fetch: 180_000,
  checkout: 60_000,
  merge: 60_000,
  pull: 1_200_000,
  recreate: 1_800_000,
};
const DEFAULT_TIMEOUT_MS = 120_000;
const COMMIT = /^[0-9a-f]{40}$/;

interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

/**
 * Every command is argv with `shell: false`. A repository URL or a branch reaches git as one
 * argument and reaches Compose not at all, so there is no string a caller can craft that becomes
 * part of a command line, a build argument, or a service definition.
 */
function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          ...options.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "true",
          CI: "1",
        },
      },
      (error, stdout, stderr) => {
        const output = truncateOutput(`${stdout}${stderr}`);
        if (!error) {
          resolve({ ok: true, exitCode: 0, output });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : null;
        resolve({ ok: false, exitCode, output: output || error.message });
      },
    );
  });
}

export function createUpdaterApp(config: UpdaterConfig) {
  const app = new Hono();
  const composeTarget = {
    composeFile: config.composeFile,
    envFiles: [config.envFile],
    projectName: config.projectName,
  };
  let running = false;

  app.get("/health", (c) => c.json({ ok: true, service: "updater", image: config.image }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    if (!hasValidBearerToken(c.req.header("authorization"), config.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/state", async (c) => {
    const tags = readTagState(await readEnvFile());
    const checkout = await readCheckout();
    return c.json({
      deployDir: config.deployDir,
      composeFile: config.composeFile,
      image: config.image,
      imageRef: imageRef(config.image, tags.currentTag),
      running,
      ...tags,
      checkout,
    });
  });

  app.post("/plan", async (c) => {
    try {
      const request = parseRequest(await body(c.req.raw));
      const tags = readTagState(await readEnvFile());
      const decision = chooseUpdateStrategy(request);
      const checkout = await readCheckout();
      if (decision.strategy === "build") {
        const targetCommit = await resolveRemoteHead(request);
        return c.json({
          strategy: decision.strategy,
          reason: decision.reason,
          currentTag: tags.currentTag,
          previousTag: tags.previousTag,
          targetTag: null,
          targetCommit,
          upToDate: upToDateForBuild(tags.currentTag, checkout.commit, targetCommit),
          checkout,
        });
      }
      const targetTag = await resolveReleaseTag(request.repoUrl);
      return c.json({
        strategy: decision.strategy,
        reason: decision.reason,
        currentTag: tags.currentTag,
        previousTag: tags.previousTag,
        targetTag,
        targetCommit: null,
        upToDate: targetTag === tags.currentTag,
        checkout,
      });
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/apply", async (c) => {
    try {
      const request = parseRequest(await body(c.req.raw));
      return c.json(await apply(request));
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/rollback", async (c) => {
    try {
      return c.json(await rollback());
    } catch (error) {
      return refusal(c, error);
    }
  });

  return app;

  async function body(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }

  /** The sidecar is its own trust boundary: it re-validates rather than trusting the API's checks. */
  function parseRequest(input: unknown) {
    const source = (input ?? {}) as { repoUrl?: unknown; branch?: unknown };
    const result = validateUpdateRequest(source);
    if ("error" in result) throw new UpdateRefused(result.error);
    return result.request;
  }

  function refusal(c: Context, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, error instanceof UpdateRefused ? 400 : 500);
  }

  function readEnvFile() {
    return readFile(config.envFile, "utf8").catch(() => "");
  }

  async function writeEnvAssignments(assignments: Record<string, string>) {
    const contents = upsertEnvAssignments(await readEnvFile(), assignments);
    const temporary = `${config.envFile}.rakazo-update`;
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, config.envFile);
  }

  function git(args: string[], stepId = "read") {
    return runCommand("git", args, {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async function hasCheckout() {
    try {
      await access(path.posix.join(config.deployDir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  async function readCheckout() {
    if (!(await hasCheckout())) {
      return {
        present: false,
        commit: null,
        branch: null,
        remoteUrl: null,
        dirty: false,
        dirtyPaths: [] as string[],
      };
    }
    const [head, branch, remote, status] = await Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["remote", "get-url", DEFAULT_UPDATE_REMOTE]),
      git(gitStatusArgv()),
    ]);
    const porcelain = parseGitStatusPorcelain(status.ok ? status.output : "");
    let contentChanged: string[] = [];
    let contentDiffOk = true;
    if (status.ok && !porcelain.clean) {
      const [worktree, index] = await Promise.all([
        git(gitWorktreeContentDiffArgv()),
        git(gitIndexContentDiffArgv()),
      ]);
      contentDiffOk = worktree.ok && index.ok;
      contentChanged = [
        ...parseGitNameOnly(worktree.ok ? worktree.output : ""),
        ...parseGitNameOnly(index.ok ? index.output : ""),
      ];
    }
    const tracked = resolveTrackedDirtyPaths({
      porcelainChanged: porcelain.changed,
      contentChanged,
      contentDiffOk,
    });
    return {
      present: true,
      commit: head.ok ? head.output.trim() : null,
      branch: branch.ok ? branch.output.trim() : null,
      remoteUrl: remote.ok ? remote.output.trim() : null,
      dirty: status.ok ? tracked.dirty : false,
      dirtyPaths: tracked.dirtyPaths,
    };
  }

  /** `ls-remote` reads the tag list without cloning, so it works for the pull path with no checkout. */
  async function resolveReleaseTag(repoUrl: string) {
    const listed = await runCommand("git", ["ls-remote", "--tags", "--", repoUrl], {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS,
    });
    if (!listed.ok) {
      throw new UpdateRefused(`Could not read releases from ${repoUrl}: ${listed.output}`);
    }
    const tag = selectLatestReleaseTag(parseLsRemoteTags(listed.output));
    if (tag === null) {
      throw new UpdateRefused(
        `${repoUrl} has no published release tags, so there is no image to pull.`,
      );
    }
    return tag;
  }

  /** The branch head on the remote, read without fetching, so a plan does not mutate the checkout. */
  async function resolveRemoteHead(request: { repoUrl: string; branch: string }) {
    const listed = await runCommand(
      "git",
      ["ls-remote", "--heads", "--", request.repoUrl, request.branch],
      { cwd: config.deployDir, timeoutMs: STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS },
    );
    if (!listed.ok) {
      throw new UpdateRefused(`Could not read ${request.branch} from ${request.repoUrl}.`);
    }
    const commit = listed.output.trim().split(/\s/)[0] ?? "";
    if (!COMMIT.test(commit)) {
      throw new UpdateRefused(`${request.repoUrl} has no branch called ${request.branch}.`);
    }
    return commit;
  }

  /** A fork is current only when its checkout is on the remote head *and* that build is deployed. */
  function upToDateForBuild(
    currentTag: string,
    commit: string | null,
    targetCommit: string | null,
  ) {
    if (commit === null || targetCommit === null || commit !== targetCommit) return false;
    return currentTag === forkImageTag(commit);
  }

  async function apply(request: { repoUrl: string; branch: string; official: boolean }) {
    if (running) throw new UpdateRefused("An update is already running.");
    const decision = chooseUpdateStrategy(request);
    const tags = readTagState(await readEnvFile());
    const checkout = await readCheckout();

    if (decision.strategy === "build") {
      if (!checkout.present) {
        throw new UpdateRefused(
          "Building a fork needs the deployment's git checkout, and RAKAZO_DEPLOY_DIR has no .git directory. Clone the fork to the deployment directory, or switch back to the official repository to use published images.",
        );
      }
      if (checkout.dirty) {
        throw new UpdateRefused(
          "The deployment checkout has uncommitted changes to tracked files. Commit, stash, or discard them before updating.",
        );
      }
    }

    let targetTag: string | null = null;
    if (decision.strategy === "pull") {
      targetTag = await resolveReleaseTag(request.repoUrl);
      if (targetTag === tags.currentTag) return upToDateRecord(request, targetTag, "pull");
    } else {
      const remoteHead = await resolveRemoteHead(request);
      if (upToDateForBuild(tags.currentTag, checkout.commit, remoteHead)) {
        return upToDateRecord(request, tags.currentTag, "build");
      }
    }

    const steps =
      decision.strategy === "pull"
        ? composeUpdatePlan({ strategy: "pull", target: composeTarget })
        : composeUpdatePlan({
            strategy: "build",
            target: composeTarget,
            repoUrl: request.repoUrl,
            branch: request.branch,
            repointRemote:
              checkout.remoteUrl === null ||
              repoIdentity(checkout.remoteUrl) !== repoIdentity(request.repoUrl),
          });

    return execute({
      request,
      strategy: decision.strategy,
      fromTag: tags.currentTag,
      originalPreviousTag: tags.previousTag,
      toTag: targetTag,
      fromCommit: checkout.commit,
      steps,
      restartAdvice:
        decision.strategy === "pull"
          ? "The updater pulled the new images and recreated the API, worker, and web containers. Migrations ran inside the new API container before it started serving."
          : "The updater built the fork and recreated the API, worker, and web containers. Migrations ran inside the new API container before it started serving.",
    });
  }

  async function rollback(): Promise<ServerUpdateRun> {
    if (running) throw new UpdateRefused("An update is already running.");
    const tags = readTagState(await readEnvFile());
    const decision = rollbackTarget(tags);
    if ("error" in decision) throw new UpdateRefused(decision.error);
    const checkout = await readCheckout();
    const steps = composeUpdatePlan({ strategy: "pull", target: composeTarget }).filter(
      (step) => step.id !== "pull" || !isLocalImageTag(decision.tag),
    );
    return execute({
      request: { repoUrl: "", branch: "" },
      strategy: "pull",
      fromTag: tags.currentTag,
      originalPreviousTag: tags.previousTag,
      toTag: decision.tag,
      fromCommit: checkout.commit,
      steps,
      restartAdvice: `Rolled back to ${decision.tag}. Database migrations are not reversed: if the newer version added a migration, roll forward again or restore a database backup.`,
    });
  }

  /**
   * Pins the tag, runs the plan, and un-pins it again if the run failed, so a failed update never
   * leaves the deployment's `.env` pointing at an image the host does not have.
   */
  async function execute(input: {
    request: { repoUrl: string; branch: string };
    strategy: "pull" | "build";
    fromTag: string;
    originalPreviousTag: string | null;
    toTag: string | null;
    fromCommit: string | null;
    steps: ComposeUpdateStep[];
    restartAdvice: string;
  }): Promise<ServerUpdateRun> {
    running = true;
    const record: ServerUpdateRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: false,
      fromCommit: input.fromCommit,
      toCommit: null,
      fromTag: input.fromTag,
      toTag: input.toTag,
      strategy: input.strategy,
      repoUrl: input.request.repoUrl,
      branch: input.request.branch,
      restart: "recreated",
      restartAdvice: input.restartAdvice,
      error: null,
      steps: [],
    };
    const revertAssignments = {
      [IMAGE_TAG_ENV]: input.fromTag,
      [PREVIOUS_IMAGE_TAG_ENV]: input.originalPreviousTag ?? input.fromTag,
    };
    try {
      const gitSteps = input.steps.filter((step) => step.command === "git");
      const composeSteps = input.steps.filter((step) => step.command !== "git");

      for (const step of gitSteps) {
        if (!(await runStep(record, step))) return finish(record);
      }

      // The build path only knows its tag after the fast-forward, because the tag is the commit.
      let toTag = input.toTag;
      if (input.strategy === "build") {
        const head = await git(["rev-parse", "HEAD"]);
        const commit = head.ok ? head.output.trim() : "";
        if (!COMMIT.test(commit)) {
          record.error = "Could not read the commit to build.";
          return finish(record);
        }
        record.toCommit = commit;
        toTag = forkImageTag(commit);
        record.toTag = toTag;
      }
      if (toTag === null) {
        record.error = "Could not resolve a target image tag.";
        return finish(record);
      }

      await writeEnvAssignments({
        [IMAGE_TAG_ENV]: toTag,
        [PREVIOUS_IMAGE_TAG_ENV]: input.fromTag,
      });
      const composeEnv: Record<string, string> = { [IMAGE_TAG_ENV]: toTag };
      if (record.toCommit !== null) composeEnv.GIT_SHA = record.toCommit;

      for (const step of composeSteps) {
        if (!(await runStep(record, step, composeEnv))) {
          await writeEnvAssignments(revertAssignments).catch(() => undefined);
          record.restartAdvice = `${record.error} The deployment was left pinned to ${input.fromTag}; nothing was recreated past the failing step. Read the step output, fix the cause, then run the update again.`;
          return finish(record);
        }
      }
      record.ok = true;
      return finish(record);
    } finally {
      running = false;
    }
  }

  async function runStep(
    record: ServerUpdateRun,
    step: ComposeUpdateStep,
    env?: Record<string, string>,
  ) {
    const result = await runCommand(step.command, step.args, {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS[step.id] ?? DEFAULT_TIMEOUT_MS,
      env,
    });
    record.steps.push({
      id: step.id,
      label: step.label,
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output,
    });
    if (!result.ok) record.error = `${step.label} failed.`;
    return result.ok;
  }

  function finish(record: ServerUpdateRun): ServerUpdateRun {
    record.finishedAt = new Date().toISOString();
    if (!record.ok && record.restart === "recreated") record.restart = "manual";
    return record;
  }

  function upToDateRecord(
    request: { repoUrl: string; branch: string },
    tag: string,
    strategy: "pull" | "build",
  ): ServerUpdateRun {
    const now = new Date().toISOString();
    return {
      startedAt: now,
      finishedAt: now,
      ok: true,
      fromCommit: null,
      toCommit: null,
      fromTag: tag,
      toTag: tag,
      strategy,
      repoUrl: request.repoUrl,
      branch: request.branch,
      restart: "not-required",
      restartAdvice: `Already running ${tag}; nothing was changed.`,
      error: null,
      steps: [],
    };
  }
}

function startUpdater() {
  const config = resolveUpdaterConfig(process.env);
  const app = createUpdaterApp(config);
  return serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    console.log(`rakazo updater on http://${config.host}:${config.port} for ${config.deployDir}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startUpdater();
}
