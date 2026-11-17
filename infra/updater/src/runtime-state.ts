import { createHash } from "node:crypto";
import type { RemoteRelease } from "@rakazo/core";
import {
  commitImageTag,
  imageRef,
  isGitCommit,
  isValidImageTag,
  PUBLISHED_IMAGE_REPO,
  selectLatestRelease,
} from "@rakazo/core";
import type { UpdaterCommandRunner } from "./index.js";
import type { UpdaterConfig } from "./updater-logic.js";
import { readEnvAssignment, UpdateRefused } from "./updater-logic.js";

export const COMPUTER_TAG_ENV = "RAKAZO_COMPUTER_IMAGE_TAG";
export const PREVIOUS_COMPUTER_TAG_ENV = "RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS";
const COMPUTER_IMAGE = `ghcr.io/${PUBLISHED_IMAGE_REPO}/computer`;
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
  previousTag: string | null;
  toTag: string;
}

export function rollbackComputerTags(
  config: UpdaterConfig,
  env: string,
): ComputerTagChange | undefined {
  if (!config.updateServices.includes("computer")) return undefined;
  const previousTag = readEnvAssignment(env, PREVIOUS_COMPUTER_TAG_ENV);
  if (!previousTag || !isValidImageTag(previousTag))
    throw new UpdateRefused(
      "Rollback requires a valid previous computer image pin. Restore the matching cached computer pin or repair the application and computer images manually before retrying. Nothing was recreated.",
    );
  return {
    fromTag: readEnvAssignment(env, COMPUTER_TAG_ENV) || "latest",
    previousTag,
    toTag: previousTag,
  };
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

/** Keep the verified running image addressable even when it arrived through a one-off override. */
export async function cacheRuntimeBaseline(
  config: UpdaterConfig,
  state: RuntimeState,
  run: UpdaterCommandRunner,
) {
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const id = state.baseline.imageId;
  const tagged = await run(
    "docker",
    ["image", "tag", id, imageRef(config.image, state.baseline.tag)],
    options,
  );
  if (!tagged.ok) throw new UpdateRefused("Could not cache the verified running image.");
}

/** Preserve local image bytes independently of mutable source tags and later pulls. */
export async function cacheComputerImage(
  config: UpdaterConfig,
  env: string,
  tag: string,
  run: UpdaterCommandRunner,
): Promise<string> {
  const image = readEnvAssignment(env, "RAKAZO_COMPUTER_IMAGE") || COMPUTER_IMAGE;
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

/** Remove only obsolete updater cache tags; Docker protects images still used by containers. */
export async function pruneComputerCache(
  config: UpdaterConfig,
  env: string,
  run: UpdaterCommandRunner,
): Promise<void> {
  const image = readEnvAssignment(env, "RAKAZO_COMPUTER_IMAGE") || COMPUTER_IMAGE;
  const retained = new Set([
    readEnvAssignment(env, COMPUTER_TAG_ENV),
    readEnvAssignment(env, PREVIOUS_COMPUTER_TAG_ENV),
  ]);
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const listed = await run("docker", ["image", "ls", image, "--format", "{{.Tag}}"], options);
  if (!listed.ok) throw new Error("Could not list computer rollback cache tags.");
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
  if (failed.length > 0)
    throw new Error(`Could not remove obsolete computer cache tags: ${failed.join(", ")}.`);
}

export async function readScheduledComputer(
  config: UpdaterConfig,
  state: RuntimeState,
  env: string,
  targetTag: string,
  run: UpdaterCommandRunner,
): Promise<
  { tags: ComputerTagChange; envTag: string; current: boolean; uniform: boolean } | undefined
> {
  if (!config.updateServices.includes("computer")) return undefined;
  if (!config.updateServices.includes("supervisor"))
    throw new UpdateRefused(
      "Managing computer updates also requires supervisor in RAKAZO_UPDATE_SERVICES.",
    );
  const image = readEnvAssignment(env, "RAKAZO_COMPUTER_IMAGE") || COMPUTER_IMAGE;
  if (image !== COMPUTER_IMAGE)
    throw new UpdateRefused(
      "Scheduled computer updates require the official computer image; manual controls remain available.",
    );
  const envTag = readEnvAssignment(env, COMPUTER_TAG_ENV) || "latest";
  if (!isValidImageTag(envTag))
    throw new UpdateRefused("The configured computer image tag is invalid.");
  const tags: string[] = [];
  for (const service of state.services.filter((service) => service.service === "supervisor")) {
    const ref = await run(
      "docker",
      ["exec", service.id, "node", "-p", "process.env.RAKAZO_COMPUTER_IMAGE"],
      {
        cwd: config.deployDir,
        timeoutMs: READ_TIMEOUT_MS,
      },
    );
    const value = ref.stdout.trim();
    const tag = value.startsWith(`${image}:`) ? value.slice(image.length + 1) : "";
    if (!ref.ok || !isValidImageTag(tag))
      throw new UpdateRefused(
        "Could not verify the supervisor's computer image; scheduled updates were refused.",
      );
    tags.push(tag);
  }
  const selectedTarget = tags.length > 0 && tags.every((tag) => tag === targetTag);
  const local = selectedTarget
    ? await run("docker", ["image", "inspect", imageRef(image, targetTag), "--format", "{{.Id}}"], {
        cwd: config.deployDir,
        timeoutMs: READ_TIMEOUT_MS,
      })
    : undefined;
  const available = local?.ok && /^sha256:[0-9a-f]{64}$/.test(local.stdout.trim());
  return {
    tags: {
      fromTag: tags[0] ?? envTag,
      restoreTag: envTag,
      previousTag: readEnvAssignment(env, PREVIOUS_COMPUTER_TAG_ENV),
      toTag: targetTag,
    },
    envTag,
    current: selectedTarget && Boolean(available),
    uniform:
      tags.length > 0 &&
      tags.every((tag) => tag === tags[0]) &&
      (!selectedTarget || Boolean(available)),
  };
}
