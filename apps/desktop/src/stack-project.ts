import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { RunDockerResult } from "./docker-cli.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const STACK_PROJECT_FILE = ".desktop-stack-project";
const LEGACY_PROJECT = "rakazo";
const DESKTOP_PROJECT = /^rakazo-desktop-[a-f0-9]{32}$/;
export const STACK_OWNERSHIP_FAILED =
  "Could not verify local stack ownership. Check the existing Docker installation before retrying.";

export class StackOwnershipError extends Error {
  constructor() {
    super(STACK_OWNERSHIP_FAILED);
  }
}

type InspectDocker = (args: string[]) => Promise<RunDockerResult>;

/** Distinguish a missing identity from an existing file that the private reader rejected. */
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Inspect stopped containers too; a healthy web listener proves nothing about its neighbours. */
async function inspectStackProjectContainers(
  project: string,
  dir: string,
  composeFile: string,
  inspect: InspectDocker,
): Promise<number> {
  const listed = await inspect([
    "container",
    "ls",
    "--all",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    "{{.ID}}",
  ]);
  if (listed.code !== 0) throw new StackOwnershipError();
  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) return 0;
  if (!ids.every((id) => /^[a-f0-9]{12,64}$/.test(id))) throw new StackOwnershipError();
  const inspected = await inspect([
    "container",
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    ...ids,
  ]);
  if (inspected.code !== 0) throw new StackOwnershipError();
  try {
    const labels = inspected.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (labels.length !== ids.length) throw new StackOwnershipError();
    const canonicalDir = await realpath(dir);
    for (const label of labels) {
      const workingDir = label?.["com.docker.compose.project.working_dir"];
      const configFile = label?.["com.docker.compose.project.config_files"];
      if (
        label?.["com.docker.compose.project"] !== project ||
        typeof workingDir !== "string" ||
        typeof configFile !== "string" ||
        !path.isAbsolute(workingDir) ||
        !path.isAbsolute(configFile) ||
        path.basename(configFile) !== composeFile ||
        (await realpath(workingDir)) !== canonicalDir ||
        (await realpath(path.dirname(configFile))) !== canonicalDir
      )
        throw new StackOwnershipError();
    }
  } catch {
    throw new StackOwnershipError();
  }
  return ids.length;
}

/** A saved legacy identity still needs live provenance; empty new projects may be resumed. */
export async function assertStackProjectOwnership(
  project: string,
  dir: string,
  composeFile: string,
  inspect: InspectDocker,
): Promise<void> {
  const count = await inspectStackProjectContainers(project, dir, composeFile, inspect);
  // Persisted legacy identities never authorize adopting orphaned volumes.
  if (count === 0 && project === LEGACY_PROJECT) throw new StackOwnershipError();
}

/** Persist before creating .env so an interrupted first start can safely resume. */
export async function resolveStackProject(input: {
  dir: string;
  composeFile: string;
  envFile: string;
  create: boolean;
  randomHex: (bytes: number) => string;
  inspect: InspectDocker;
}): Promise<string | null> {
  const file = path.join(input.dir, STACK_PROJECT_FILE);
  const saved = (await readPrivateFile(file, 128))?.trim();
  if (saved !== undefined && (saved === LEGACY_PROJECT || DESKTOP_PROJECT.test(saved))) {
    await assertStackProjectOwnership(saved, input.dir, input.composeFile, input.inspect);
    return saved;
  }
  if (await exists(file)) throw new StackOwnershipError();
  let project: string | null = null;
  if (await exists(path.join(input.dir, input.envFile))) {
    // Releases before project isolation used this name, including releases before
    // the private web token. Compose's directory labels are the compatibility proof.
    const count = await inspectStackProjectContainers(
      LEGACY_PROJECT,
      input.dir,
      input.composeFile,
      input.inspect,
    );
    if (count > 0) project = LEGACY_PROJECT;
    else {
      // A failed first pull left .env before any Docker resources were created.
      // Only resume with a new project if there is no legacy data to strand. List
      // names rather than trusting labels: old or restored volumes may lack them.
      const volumes = await input.inspect(["volume", "ls", "--format", "{{.Name}}"]);
      if (
        volumes.code !== 0 ||
        volumes.stdout.split(/\s+/).some((name) => name.startsWith(`${LEGACY_PROJECT}_`))
      ) {
        throw new StackOwnershipError();
      }
    }
  }
  if (project === null) {
    if (!input.create) return null;
    project = `rakazo-desktop-${input.randomHex(16)}`;
    if (!DESKTOP_PROJECT.test(project)) throw new StackOwnershipError();
  }
  await assertStackProjectOwnership(project, input.dir, input.composeFile, input.inspect);
  await writePrivateFile(file, `${project}\n`);
  return project;
}
