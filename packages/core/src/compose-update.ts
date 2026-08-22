import {
  DEFAULT_UPDATE_REMOTE,
  isOfficialRepoUrl,
  normalizeRepoUrl,
  normalizeUpdateBranch,
} from "./self-update.js";

/**
 * The GitHub repository whose CI fills the image namespace. `publish-server-image.yml` pushes to
 * `ghcr.io/${{ github.repository }}`, so the namespace always belongs to whichever repository ran
 * the workflow. Naming a different owner here points the deployment at packages nobody publishes.
 *
 * Note that `OFFICIAL_REPO_URL` still names the upstream repository, not this one. The pull path
 * reads release tags from `OFFICIAL_REPO_URL` and then pulls that tag from this namespace, so the
 * two only agree when the same repository both tags releases and publishes images. See the
 * follow-up noted in docs/self-host.md before relying on the pull path.
 */
export const PUBLISHED_IMAGE_REPO = "millson1/rakazo";

/** The published server image. One image runs api, worker, and web. */
export const OFFICIAL_SERVER_IMAGE = `ghcr.io/${PUBLISHED_IMAGE_REPO}/app`;
/** The updater sidecar's image, published alongside the server image but tagged independently. */
export const OFFICIAL_UPDATER_IMAGE = `ghcr.io/${PUBLISHED_IMAGE_REPO}/updater`;

/**
 * The tag a deployment that has never run an update is on. It is deliberately *not* `latest`: no
 * registry serves this tag, so `docker compose up --build` builds it from the checkout and a fresh
 * install works with an empty registry. `latest` only exists once a release has been published.
 */
export const LOCAL_IMAGE_TAG = "local";
export const DEFAULT_IMAGE_TAG = LOCAL_IMAGE_TAG;
export const IMAGE_TAG_ENV = "RAKAZO_IMAGE_TAG";
export const PREVIOUS_IMAGE_TAG_ENV = "RAKAZO_IMAGE_TAG_PREVIOUS";

/**
 * The services a recreate replaces. `updater` is deliberately absent: it is the process running
 * the update, and recreating it would kill the run half way through. `postgres` and `caddy` are
 * absent because neither uses the Rakazo image.
 */
export const RECREATED_SERVICES = ["api", "worker", "web"] as const;

const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const IMAGE_NAME_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IMAGE_HOST = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const ENV_VALUE = /^[A-Za-z0-9._:/@+-]{0,256}$/;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function isValidImageTag(tag: string): boolean {
  return IMAGE_TAG.test(tag);
}

/** A registry reference the updater is willing to hand to `docker compose` as one env value. */
export function isValidImageName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  const segments = name.split("/");
  const first = segments[0] ?? "";
  const hasHost = segments.length > 1 && (first.includes(".") || first.includes(":"));
  if (hasHost && !IMAGE_HOST.test(first)) return false;
  return segments.slice(hasHost ? 1 : 0).every((segment) => IMAGE_NAME_SEGMENT.test(segment));
}

export function imageRef(name: string, tag: string): string {
  if (!isValidImageName(name)) throw new Error(`Refusing an unusable image name: ${name}`);
  if (!isValidImageTag(tag)) throw new Error(`Refusing an unusable image tag: ${tag}`);
  return `${name}:${tag}`;
}

/**
 * The tag a fork's build is stored under. Forks have no published images, so the tag has to be
 * local and distinguishable from anything the registry could serve, or a later `pull` of the same
 * name would silently replace the operator's own build.
 */
export function forkImageTag(commit: string): string {
  if (!COMMIT.test(commit)) throw new Error("A fork build needs a resolved commit to tag.");
  return `local-${commit.slice(0, 12)}`;
}

/**
 * A tag that only exists on this host, so trying to pull it would fail rather than find nothing.
 * Covers both the per-commit fork builds (`local-<commit>`) and the bare `local` a fresh install
 * builds, because a rollback onto either has to skip `docker compose pull`.
 */
export function isLocalImageTag(tag: string): boolean {
  return tag === LOCAL_IMAGE_TAG || tag.startsWith(`${LOCAL_IMAGE_TAG}-`);
}

/**
 * The immutable per-commit tag the publish workflow pushes. This has to agree character for
 * character with `docker/metadata-action`'s `type=sha`, or a deployment could not pull what CI
 * published: that action defaults to `prefix=sha-` and `format=short`, and its short SHA is 7
 * characters. Setting `DOCKER_METADATA_SHORT_SHA_LENGTH` in the workflow would break the agreement.
 */
export function commitImageTag(commit: string): string {
  if (!COMMIT.test(commit)) throw new Error("A commit tag needs a resolved commit.");
  return `sha-${commit.slice(0, 7)}`;
}

export interface ReleaseTag {
  tag: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseReleaseTag(tag: string): ReleaseTag | null {
  const match = RELEASE_TAG.exec(tag);
  if (!match) return null;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function compareReleaseTags(a: ReleaseTag, b: ReleaseTag): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** Reads `git ls-remote --tags <url>`, which is the tag list without cloning anything. */
export function parseLsRemoteTags(stdout: string): string[] {
  const tags = new Set<string>();
  for (const line of stdout.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (!ref?.startsWith("refs/tags/")) continue;
    const tag = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (tag !== "" && isValidImageTag(tag)) tags.add(tag);
  }
  return [...tags];
}

/**
 * The newest stable release. Pre-releases are skipped because "update to latest" should not move a
 * deployment onto a release candidate, and there is no way to opt back out once it has recreated.
 */
export function selectLatestReleaseTag(tags: readonly string[]): string | null {
  let best: ReleaseTag | null = null;
  for (const tag of tags) {
    const parsed = parseReleaseTag(tag);
    if (!parsed || parsed.prerelease !== null) continue;
    if (best === null || compareReleaseTags(parsed, best) > 0) best = parsed;
  }
  return best?.tag ?? null;
}

export type UpdateStrategy = "pull" | "build";

export interface StrategyDecision {
  strategy: UpdateStrategy;
  reason: string;
}

/**
 * Only the official repository has published images. A fork has to be built where it is deployed,
 * which is minutes rather than seconds, so the choice is stated rather than guessed at call sites.
 */
export function chooseUpdateStrategy(input: { official: boolean }): StrategyDecision {
  if (input.official) {
    return {
      strategy: "pull",
      reason: "Official releases are published as images, so the update is a download and restart.",
    };
  }
  return {
    strategy: "build",
    reason:
      "A fork has no published images, so the server builds this update itself. Expect minutes, not seconds.",
  };
}

export type ExecutionMode = "sidecar" | "checkout" | "unavailable";

export interface ExecutionModeDecision {
  mode: ExecutionMode;
  reason: string | null;
}

/**
 * Which of the two engines can actually apply an update here. The sidecar wins whenever it is
 * configured: a Compose deployment's own container has no `.git` and nothing to restart it, so its
 * only route is the container that outlives it.
 */
export function resolveExecutionMode(input: {
  hasUpdater?: boolean;
  hasCheckout?: boolean;
  disabled?: boolean;
}): ExecutionModeDecision {
  if (input.disabled === true) {
    return { mode: "unavailable", reason: "Self-update is switched off for this deployment." };
  }
  if (input.hasUpdater === true) return { mode: "sidecar", reason: null };
  if (input.hasCheckout === true) return { mode: "checkout", reason: null };
  return {
    mode: "unavailable",
    reason:
      "This deployment has neither an updater sidecar nor a git checkout, so it cannot update itself. Add the `updater` service from infra/compose/docker-compose.prod.yml.",
  };
}

export interface ComposeInvocation {
  command: string;
  args: string[];
}

export interface ComposeTarget {
  composeFile: string;
  envFiles?: readonly string[];
}

function composeBase(target: ComposeTarget): string[] {
  const args = ["compose"];
  for (const envFile of target.envFiles ?? []) args.push("--env-file", envFile);
  args.push("--file", target.composeFile);
  return args;
}

export function composePullArgv(
  target: ComposeTarget,
  services: readonly string[] = RECREATED_SERVICES,
): ComposeInvocation {
  return { command: "docker", args: [...composeBase(target), "pull", ...services] };
}

export function composeUpArgv(
  target: ComposeTarget,
  options: { build?: boolean; services?: readonly string[] } = {},
): ComposeInvocation {
  const args = [...composeBase(target), "up", "--detach"];
  if (options.build === true) args.push("--build");
  args.push(...(options.services ?? RECREATED_SERVICES));
  return { command: "docker", args };
}

export function composePsArgv(target: ComposeTarget): ComposeInvocation {
  return { command: "docker", args: [...composeBase(target), "ps", "--format", "json"] };
}

export interface ComposeUpdateStep {
  id: string;
  label: string;
  command: string;
  args: string[];
}

export interface ComposeUpdatePlanInput {
  strategy: UpdateStrategy;
  target: ComposeTarget;
  /** Only the build path touches the checkout, and only when the remote has to be re-pointed. */
  repoUrl?: string;
  branch?: string;
  repointRemote?: boolean;
  remote?: string;
}

/**
 * Ordered work for one Compose update.
 *
 * Migrations are absent on purpose. The `api` service runs `prisma migrate deploy` as the first
 * thing in its own start command, so a recreate already orders them correctly: Compose stops the
 * old container, the new one migrates with the new code, then serves. Running migrations from here
 * would instead apply the new schema while the old process is still answering requests, which is
 * the window this ordering exists to close.
 */
export function composeUpdatePlan(input: ComposeUpdatePlanInput): ComposeUpdateStep[] {
  const steps: ComposeUpdateStep[] = [];
  if (input.strategy === "build") {
    const remote = input.remote ?? DEFAULT_UPDATE_REMOTE;
    const branch = input.branch ?? "main";
    if (input.repointRemote === true && input.repoUrl) {
      steps.push({
        id: "remote",
        label: "Point the checkout at the chosen repository",
        command: "git",
        args: ["remote", "set-url", remote, input.repoUrl],
      });
    }
    steps.push(
      {
        id: "fetch",
        label: "Fetch the latest commits",
        command: "git",
        args: ["fetch", "--prune", remote, branch],
      },
      {
        id: "checkout",
        label: `Check out ${branch}`,
        command: "git",
        args: ["checkout", branch],
      },
      {
        id: "merge",
        label: "Fast-forward to the fetched commit",
        command: "git",
        args: ["merge", "--ff-only", `${remote}/${branch}`],
      },
    );
    const up = composeUpArgv(input.target, { build: true });
    steps.push({
      id: "recreate",
      label: "Build the new images and recreate the services",
      command: up.command,
      args: up.args,
    });
    return steps;
  }

  const pull = composePullArgv(input.target);
  const up = composeUpArgv(input.target);
  steps.push(
    { id: "pull", label: "Download the new images", command: pull.command, args: pull.args },
    { id: "recreate", label: "Recreate the services", command: up.command, args: up.args },
  );
  return steps;
}

export type RollbackDecision = { tag: string } | { error: string };

/**
 * Rollback is "deploy the tag that was running before the last update". It only works because
 * every published tag is immutable and retained, so the previous tag is still pullable.
 */
export function rollbackTarget(input: {
  currentTag: string | null;
  previousTag: string | null;
}): RollbackDecision {
  if (!input.previousTag) {
    return { error: "No previous image tag was recorded, so there is nothing to roll back to." };
  }
  if (!isValidImageTag(input.previousTag)) {
    return { error: "The recorded previous image tag is not a usable tag." };
  }
  if (input.previousTag === input.currentTag) {
    return { error: "The previous image tag is the one already running." };
  }
  return { tag: input.previousTag };
}

/**
 * Rewrites managed assignments in the deployment's `.env` without disturbing anything else in it,
 * so the operator's own `docker compose --env-file .env … up -d` keeps using the pinned tag.
 * Values are checked against a conservative grammar first: this file is read by Compose as
 * interpolation input, and it is the last place a repository URL or ref could leak into a build
 * argument or a service definition.
 */
export function upsertEnvAssignments(
  contents: string,
  assignments: Readonly<Record<string, string>>,
): string {
  for (const [key, value] of Object.entries(assignments)) {
    if (!ENV_KEY.test(key)) throw new Error(`Refusing to write the env key ${key}.`);
    if (!ENV_VALUE.test(value)) throw new Error(`Refusing to write the value of ${key}.`);
  }
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  const pending = new Map(Object.entries(assignments));
  const next = lines.map((line) => {
    const key = line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    return `${key}=${value}`;
  });
  if (pending.size > 0) {
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    if (next.length > 0) next.push("");
    for (const [key, value] of pending) next.push(`${key}=${value}`);
  }
  const rendered = next.join(newline);
  return rendered.endsWith(newline) ? rendered : `${rendered}${newline}`;
}

export interface UpdateRequest {
  repoUrl: string;
  branch: string;
  official: boolean;
}

export type UpdateRequestResult = { request: UpdateRequest } | { error: string };

/**
 * The sidecar's own front door. It holds the Docker socket, so it is a separate trust boundary and
 * re-runs every check the API already ran rather than trusting that the caller sanitized anything.
 */
export function validateUpdateRequest(input: {
  repoUrl?: unknown;
  branch?: unknown;
}): UpdateRequestResult {
  if (typeof input.repoUrl !== "string") return { error: "A repository URL is required." };
  if (typeof input.branch !== "string") return { error: "A branch is required." };
  const url = normalizeRepoUrl(input.repoUrl);
  if ("error" in url) return { error: url.error };
  const branch = normalizeUpdateBranch(input.branch);
  if ("error" in branch) return { error: branch.error };
  return {
    request: { repoUrl: url.url, branch: branch.branch, official: isOfficialRepoUrl(url.url) },
  };
}
