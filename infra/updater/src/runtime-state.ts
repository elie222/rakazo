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

interface RuntimeService {
  service: string;
  id: string;
  commit: string;
}
export interface RuntimeState {
  services: RuntimeService[];
  missing: string[];
  baseline: { commit: string; tag: string; id: string };
  uniform: boolean;
}
export interface ComputerTagChange {
  fromTag: string;
  previousTag: string | null;
  toTag: string;
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
      services.push({ service, id, commit });
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
    baseline: { commit: baseline.commit, tag: commitImageTag(baseline.commit), id: source.id },
    uniform:
      missing.length === 0 && services.every((service) => service.commit === baseline.commit),
  };
}

/** Keep the verified running image addressable even when it arrived through a one-off override. */
export async function cacheRuntimeBaseline(
  config: UpdaterConfig,
  state: RuntimeState,
  run: UpdaterCommandRunner,
) {
  const options = { cwd: config.deployDir, timeoutMs: READ_TIMEOUT_MS };
  const inspected = await run(
    "docker",
    ["inspect", state.baseline.id, "--format", "{{.Image}}"],
    options,
  );
  const id = inspected.stdout.trim();
  if (!inspected.ok || !/^sha256:[0-9a-f]{64}$/.test(id))
    throw new UpdateRefused("Could not cache the verified running image.");
  const tagged = await run(
    "docker",
    ["image", "tag", id, imageRef(config.image, state.baseline.tag)],
    options,
  );
  if (!tagged.ok) throw new UpdateRefused("Could not cache the verified running image.");
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
  return {
    tags: {
      fromTag: tags[0] ?? envTag,
      previousTag: readEnvAssignment(env, PREVIOUS_COMPUTER_TAG_ENV),
      toTag: targetTag,
    },
    envTag,
    current: tags.length > 0 && tags.every((tag) => tag === targetTag),
    uniform: tags.length > 0 && tags.every((tag) => tag === tags[0]),
  };
}
