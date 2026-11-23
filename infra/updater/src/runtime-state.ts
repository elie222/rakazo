import { createHash } from "node:crypto";
import type { RemoteRelease } from "@rakazo/core";
import {
  commitImageTag,
  IMAGE_TAG_ENV,
  imageRef,
  isGitCommit,
  isValidImageTag,
  PREVIOUS_IMAGE_TAG_ENV,
  selectLatestRelease,
} from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { UpdaterCommandRunner } from "./index.js";
import type { UpdaterConfig } from "./updater-logic.js";
import {
  COMPUTER_IMAGE_ENV,
  OFFICIAL_COMPUTER_IMAGE,
  readEnvAssignment,
  UpdateRefused,
} from "./updater-logic.js";

export const COMPUTER_TAG_ENV = "RAKAZO_COMPUTER_IMAGE_TAG";
export const PREVIOUS_COMPUTER_TAG_ENV = "RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS";
const READ_TIMEOUT_MS = 120_000;
function computerCachePrefix(config: UpdaterConfig): string {
  return `cached-${createHash("sha256").update(config.projectName).digest("hex").slice(0, 16)}-`;
}

interface RuntimeService {
  service: string;
  id: string;
  commit: string;
  imageId: string;
}
export interface RuntimeState {
  services: RuntimeService[];
  missing: string[];
  baseline: { commit: string; tag: string; imageId: string };
  uniform: boolean;
}
export interface ComputerTagChange {
  fromTag: string;
  restoreTag?: string;
  sourceAvailable?: boolean;
  previousTag: string | null;
  toTag: string;
}

export async function readRollbackComputer(
  config: UpdaterConfig,
  env: string,
  run: UpdaterCommandRunner,
): Promise<ComputerTagChange | undefined> {
  if (!config.updateServices.includes("computer")) return undefined;
  const previousTag = readEnvAssignment(env, PREVIOUS_COMPUTER_TAG_ENV);
  if (!previousTag || !isValidImageTag(previousTag))
    throw new UpdateRefused(
      "Rollback requires a valid previous computer image pin. Restore the matching cached computer pin or repair the application and computer images manually before retrying. Nothing was recreated.",
    );
  const image = readEnvAssignment(env, COMPUTER_IMAGE_ENV) || OFFICIAL_COMPUTER_IMAGE;
  const previous = await run(
    "docker",
    ["image", "inspect", imageRef(image, previousTag), "--format", "{{.Id}}"],
    { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS },
  );
  if (!previous.ok || !/^sha256:[0-9a-f]{64}$/.test(previous.stdout.trim()))
    throw new UpdateRefused(
      "The previous computer image is not cached locally. Restore it before retrying rollback. Nothing was recreated.",
    );
  return (await readManualComputer(config, env, previousTag, run))?.tags;
}

/** Running application images establish the source baseline, independently of .env pins. */
export async function readScheduledRuntime(
  config: UpdaterConfig,
  releases: readonly RemoteRelease[],
  run: UpdaterCommandRunner,
): Promise<RuntimeState> {
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const services: RuntimeService[] = [];
  const missing: string[] = [];
  // computer is a completed pull/build stub, not an application runtime.
  for (const service of config.updateServices.filter((service) => service !== "computer")) {
    const containers = await run(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project=${config.projectName}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
        "--format",
        "{{.ID}}",
      ],
      options,
    );
    const ids = containers.stdout.trim() === "" ? [] : containers.stdout.trim().split(/\s+/);
    if (!containers.ok || ids.some((id) => !/^[0-9a-f]{12,64}$/.test(id))) {
      throw new UpdateRefused(
        `Could not identify the running ${service}; scheduled updates were refused.`,
      );
    }
    if (ids.length === 0) {
      if (service === "api")
        throw new UpdateRefused(
          "Could not identify the running API; scheduled updates were refused.",
        );
      missing.push(service);
    }
    for (const id of ids) {
      const source = await run(
        "docker",
        ["exec", id, "node", "-p", "process.env.GIT_SHA"],
        options,
      );
      const commit = source.stdout.trim();
      if (
        !source.ok ||
        !isGitCommit(commit) ||
        selectLatestRelease(releases.filter((release) => release.commit === commit)) === null
      ) {
        throw new UpdateRefused(
          `The running ${service} could not be verified as a published stable release. Scheduled updates were refused to avoid downgrading an edge or unknown build. Review release notes and migrate to stable manually first.`,
        );
      }
      const inspected = await run("docker", ["inspect", id, "--format", "{{.Image}}"], options);
      const imageId = inspected.stdout.trim();
      if (!inspected.ok || !/^sha256:[0-9a-f]{64}$/.test(imageId))
        throw new UpdateRefused(`Could not verify the running ${service} image ID.`);
      services.push({ service, id, commit, imageId });
    }
  }
  const baseline = selectLatestRelease(
    releases.filter((release) => services.some((service) => service.commit === release.commit)),
  );
  const source = services.find((service) => service.commit === baseline?.commit);
  if (!baseline || !source)
    throw new UpdateRefused("Could not establish a running stable baseline.");
  return {
    services,
    missing,
    baseline: {
      commit: baseline.commit,
      tag: commitImageTag(baseline.commit),
      imageId: source.imageId,
    },
    uniform:
      missing.length === 0 &&
      services.every(
        (service) => service.commit === baseline.commit && service.imageId === source.imageId,
      ),
  };
}

/** Cache the published baseline without assigning source-built bytes to a shared tag. */
export async function cacheRuntimeBaseline(
  config: UpdaterConfig,
  state: RuntimeState,
  run: UpdaterCommandRunner,
) {
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const ref = imageRef(config.image, state.baseline.tag);
  const args = ["image", "inspect", ref, "--format", "{{.Id}}"];
  let published = await run("docker", args, options);
  if (!published.ok) {
    const pulled = await run("docker", ["pull", ref], options);
    if (!pulled.ok) throw new UpdateRefused("Could not cache the published running release image.");
    published = await run("docker", args, options);
  }
  if (!published.ok || published.stdout.trim() !== state.baseline.imageId)
    throw new UpdateRefused(
      "The running image differs from the published source-commit image. Migrate this source-built or overridden deployment to published stable images manually before scheduling updates.",
    );
}

/** Preserve local image bytes independently of mutable source tags and later pulls. */
export async function cacheComputerImage(
  config: UpdaterConfig,
  env: string,
  tag: string,
  run: UpdaterCommandRunner,
): Promise<string> {
  const image = readEnvAssignment(env, COMPUTER_IMAGE_ENV) || OFFICIAL_COMPUTER_IMAGE;
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const inspected = await run(
    "docker",
    ["image", "inspect", imageRef(image, tag), "--format", "{{.Id}}"],
    options,
  );
  const id = inspected.stdout.trim();
  if (!inspected.ok || !/^sha256:[0-9a-f]{64}$/.test(id))
    throw new UpdateRefused("Could not cache the previous computer image. Nothing was recreated.");
  const cachedTag = `${computerCachePrefix(config)}${id.slice(7)}`;
  const tagged = await run("docker", ["image", "tag", id, imageRef(image, cachedTag)], options);
  if (!tagged.ok)
    throw new UpdateRefused("Could not cache the previous computer image. Nothing was recreated.");
  return cachedTag;
}

export async function pruneUpdateImages(
  config: UpdaterConfig,
  env: string,
  run: UpdaterCommandRunner,
): Promise<void> {
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const inventory = await run(
    "docker",
    [
      "ps",
      "-a",
      "--format",
      '{{.Label "com.docker.compose.project"}}\t{{.Label "rakazo.managed"}}',
    ],
    options,
  );
  if (!inventory.ok) throw new Error("Could not inspect project ownership before image cleanup.");
  const containers = inventory.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
  // Managed bot computers are workloads, not stack infrastructure; ancestor checks retain
  // their images. Another stack's inactive rollback pins are not visible through usage.
  if (
    containers.some((line) => {
      const [project, managed] = line.split("\t");
      return project !== config.projectName && !(project === "" && managed === "true");
    })
  )
    return;
  await bestEffort(
    "prune obsolete application release images",
    pruneApplicationImages(config, env, run),
  );
  if (config.updateServices.includes("computer"))
    await bestEffort("prune obsolete computer images", pruneComputerCache(config, env, run));
}

async function pruneApplicationImages(
  config: UpdaterConfig,
  env: string,
  run: UpdaterCommandRunner,
): Promise<void> {
  const listed = await run("docker", ["image", "ls", config.image, "--format", "{{.Tag}}"], {
    cwd: config.deployDir,
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (!listed.ok) throw new Error("Could not list application release images.");
  const retained = new Set([
    readEnvAssignment(env, IMAGE_TAG_ENV),
    readEnvAssignment(env, PREVIOUS_IMAGE_TAG_ENV),
  ]);
  await pruneReleaseImages(config, config.image, retained, listed.stdout.trim().split(/\s+/), run);
}

/** Remove only obsolete updater cache tags; Docker protects images still used by containers. */
export async function pruneComputerCache(
  config: UpdaterConfig,
  env: string,
  run: UpdaterCommandRunner,
): Promise<void> {
  const image = readEnvAssignment(env, COMPUTER_IMAGE_ENV) || OFFICIAL_COMPUTER_IMAGE;
  const retained = new Set([
    readEnvAssignment(env, COMPUTER_TAG_ENV),
    readEnvAssignment(env, PREVIOUS_COMPUTER_TAG_ENV),
  ]);
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const listed = await run("docker", ["image", "ls", image, "--format", "{{.Tag}}"], options);
  if (!listed.ok) throw new Error("Could not list computer rollback cache tags.");
  await retainSupervisorImages(config, image, retained, run);
  const prefix = computerCachePrefix(config);
  const failed: string[] = [];
  for (const tag of new Set(listed.stdout.trim().split(/\s+/))) {
    if (
      !tag.startsWith(prefix) ||
      !/^[0-9a-f]{64}$/.test(tag.slice(prefix.length)) ||
      retained.has(tag)
    )
      continue;
    const removed = await run("docker", ["image", "rm", imageRef(image, tag)], options);
    if (!removed.ok) failed.push(tag);
  }
  await pruneReleaseImages(config, image, retained, listed.stdout.trim().split(/\s+/), run);
  if (failed.length > 0)
    throw new Error(`Could not remove obsolete computer cache tags: ${failed.join(", ")}.`);
}

async function retainSupervisorImages(
  config: UpdaterConfig,
  image: string,
  retained: Set<string | null>,
  run: UpdaterCommandRunner,
): Promise<void> {
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const supervisors = await run(
    "docker",
    ["ps", "--filter", "label=com.docker.compose.service=supervisor", "--format", "{{.ID}}"],
    options,
  );
  const ids = supervisors.stdout.trim() ? supervisors.stdout.trim().split(/\s+/) : [];
  if (!supervisors.ok || ids.some((id) => !/^[0-9a-f]{12,64}$/.test(id)))
    throw new Error("Could not identify supervisors before computer image cleanup.");
  for (const id of ids) {
    const selected = await run(
      "docker",
      ["exec", id, "node", "-p", `process.env.${COMPUTER_IMAGE_ENV}`],
      options,
    );
    if (!selected.ok)
      throw new Error("Could not inspect supervisor image references before cleanup.");
    const ref = selected.stdout.trim();
    if (ref.startsWith(`${image}:`)) retained.add(ref.slice(image.length + 1));
  }
}

/** Delete only unused release-only images; aliases and other stacks retain their bytes. */
async function pruneReleaseImages(
  config: UpdaterConfig,
  image: string,
  retained: Set<string | null>,
  tags: string[],
  run: UpdaterCommandRunner,
): Promise<void> {
  const releases = tags.filter((tag) => /^sha-[0-9a-f]{40}$/.test(tag));
  if (releases.length === 0) return;
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const processed = new Set<string>();
  for (const tag of releases) {
    if (retained.has(tag) || processed.has(tag)) continue;
    const ref = imageRef(image, tag);
    const inspected = await run(
      "docker",
      ["image", "inspect", ref, "--format", "{{json .RepoTags}}"],
      options,
    );
    if (!inspected.ok) throw new Error("Could not inspect release references before cleanup.");
    const references: unknown = JSON.parse(inspected.stdout);
    // Any remaining cache, operator or selected release tag retains the image bytes.
    if (!Array.isArray(references) || references.length === 0) continue;
    const obsoleteReferences = references.filter(
      (value): value is string =>
        typeof value === "string" &&
        value.startsWith(`${image}:`) &&
        /^sha-[0-9a-f]{40}$/.test(value.slice(image.length + 1)) &&
        !retained.has(value.slice(image.length + 1)),
    );
    if (obsoleteReferences.length !== references.length) continue;
    const users = await run(
      "docker",
      ["ps", "-a", "--filter", `ancestor=${ref}`, "--format", "{{.ID}}"],
      options,
    );
    if (!users.ok) throw new Error("Could not inspect release image usage before cleanup.");
    if (users.stdout.trim()) continue;
    for (const reference of obsoleteReferences) processed.add(reference.slice(image.length + 1));
    const removed = await run("docker", ["image", "rm", ...obsoleteReferences], options);
    if (!removed.ok) throw new Error("Could not remove an obsolete release image.");
  }
}

interface ComputerState {
  tags: ComputerTagChange;
  envTag: string;
  current: boolean;
  uniform: boolean;
}

export async function readScheduledComputer(
  config: UpdaterConfig,
  state: RuntimeState,
  env: string,
  targetTag: string,
  run: UpdaterCommandRunner,
): Promise<ComputerState | undefined> {
  if (!config.updateServices.includes("computer")) return undefined;
  const image = readEnvAssignment(env, COMPUTER_IMAGE_ENV) || OFFICIAL_COMPUTER_IMAGE;
  if (image !== OFFICIAL_COMPUTER_IMAGE)
    throw new UpdateRefused(
      "Scheduled computer updates require the official computer image; manual controls remain available.",
    );
  return readComputerSelection(
    config,
    env,
    targetTag,
    state.services
      .filter((service) => service.service === "supervisor")
      .map((service) => service.id),
    run,
  );
}

export async function readManualComputer(
  config: UpdaterConfig,
  env: string,
  targetTag: string,
  run: UpdaterCommandRunner,
): Promise<ComputerState | undefined> {
  if (!config.updateServices.includes("computer")) return undefined;
  const selected = await run(
    "docker",
    [
      "ps",
      "--filter",
      `label=com.docker.compose.project=${config.projectName}`,
      "--filter",
      "label=com.docker.compose.service=supervisor",
      "--format",
      "{{.ID}}",
    ],
    { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS },
  );
  const ids = selected.stdout.trim() ? selected.stdout.trim().split(/\s+/) : [];
  if (!selected.ok || ids.some((id) => !/^[0-9a-f]{12,64}$/.test(id)))
    throw new UpdateRefused("Could not identify the running supervisor before updating.");
  return readComputerSelection(config, env, targetTag, ids, run);
}

async function readComputerSelection(
  config: UpdaterConfig,
  env: string,
  targetTag: string,
  ids: string[],
  run: UpdaterCommandRunner,
): Promise<ComputerState> {
  if (!config.updateServices.includes("supervisor"))
    throw new UpdateRefused(
      "Managing computer updates also requires supervisor in RAKAZO_UPDATE_SERVICES.",
    );
  const image = readEnvAssignment(env, COMPUTER_IMAGE_ENV) || OFFICIAL_COMPUTER_IMAGE;
  const envTag = readEnvAssignment(env, COMPUTER_TAG_ENV) || "latest";
  if (!isValidImageTag(envTag))
    throw new UpdateRefused("The configured computer image tag is invalid.");
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const tags: string[] = [];
  for (const id of ids) {
    const ref = await run(
      "docker",
      ["exec", id, "node", "-p", `process.env.${COMPUTER_IMAGE_ENV}`],
      options,
    );
    const value = ref.stdout.trim();
    const tag = value.startsWith(`${image}:`) ? value.slice(image.length + 1) : "";
    if (!ref.ok || !isValidImageTag(tag))
      throw new UpdateRefused("Could not verify the supervisor's computer image before updating.");
    tags.push(tag);
  }
  const fromTag = tags[0] ?? envTag;
  const local = await run(
    "docker",
    ["image", "inspect", imageRef(image, fromTag), "--format", "{{.Id}}"],
    options,
  );
  const available = local.ok && /^sha256:[0-9a-f]{64}$/.test(local.stdout.trim());
  const uniform = tags.length > 0 && tags.every((tag) => tag === fromTag) && available;
  return {
    tags: {
      fromTag,
      restoreTag: envTag,
      sourceAvailable: uniform,
      previousTag: readEnvAssignment(env, PREVIOUS_COMPUTER_TAG_ENV),
      toTag: targetTag,
    },
    envTag,
    current: uniform && tags.every((tag) => tag === targetTag),
    uniform,
  };
}
