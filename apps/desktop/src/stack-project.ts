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
export async function assertStackProjectOwnership(
  project: string,
  dir: string,
  composeFile: string,
  inspect: InspectDocker,
): Promise<void> {
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
  if (ids.length === 0) {
    // Old volumes have no directory labels. Never adopt an orphaned legacy volume
    // or silently replace an existing installation with a fresh, empty database.
    if (project === LEGACY_PROJECT) throw new StackOwnershipError();
    return;
  }
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
  let project: string;
  if (await exists(path.join(input.dir, input.envFile))) {
    // Releases before project isolation used this name, including releases before
    // the private web token. Compose's directory labels are the compatibility proof.
    project = LEGACY_PROJECT;
  } else {
    if (!input.create) return null;
    project = `rakazo-desktop-${input.randomHex(16)}`;
    if (!DESKTOP_PROJECT.test(project)) throw new StackOwnershipError();
  }
  await assertStackProjectOwnership(project, input.dir, input.composeFile, input.inspect);
  await writePrivateFile(file, `${project}\n`);
  return project;
}
