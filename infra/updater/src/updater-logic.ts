import path from "node:path";
import {
  DEFAULT_IMAGE_TAG,
  IMAGE_TAG_ENV,
  isValidImageName,
  isValidImageTag,
  OFFICIAL_SERVER_IMAGE,
  PREVIOUS_IMAGE_TAG_ENV,
  resolveComposeProjectName,
  resolveUpdaterToken,
} from "@rakazo/core";

export const DEFAULT_UPDATER_PORT = 7092;
export const DEFAULT_COMPOSE_FILE = "infra/compose/docker-compose.prod.yml";
export const MAX_STEP_OUTPUT = 8_000;

export interface UpdaterConfig {
  /** Bind-mounted at the same absolute path it has on the host, so Compose resolves identically. */
  deployDir: string;
  composeFile: string;
  envFile: string;
  /** Passed as `docker compose -p`. Compose injects this into running services. */
  projectName: string;
  image: string;
  token: string;
  host: string;
  port: number;
}

/**
 * The deployment directory has to be an absolute path because Compose derives every relative bind
 * mount from it. Mounting it anywhere other than its host path would make this container reconcile
 * a *different* tree than the operator's. The project name is passed as `-p` separately so a custom
 * `docker compose -p` stack is the one that is updated.
 */
export function resolveUpdaterConfig(env: NodeJS.ProcessEnv): UpdaterConfig {
  const deployDir = env.RAKAZO_DEPLOY_DIR?.trim() ?? "";
  if (deployDir === "" || !path.posix.isAbsolute(deployDir)) {
    throw new Error("Set RAKAZO_DEPLOY_DIR to the absolute path of the deployment directory.");
  }
  const image = env.RAKAZO_IMAGE?.trim() || OFFICIAL_SERVER_IMAGE;
  if (!isValidImageName(image))
    throw new Error(`RAKAZO_IMAGE is not a usable image name: ${image}`);
  const composeFile = env.RAKAZO_COMPOSE_FILE?.trim() || DEFAULT_COMPOSE_FILE;
  if (path.posix.isAbsolute(composeFile) || composeFile.split("/").includes("..")) {
    throw new Error("RAKAZO_COMPOSE_FILE must be a path inside the deployment directory.");
  }
  const port = Number(env.RAKAZO_UPDATER_PORT ?? DEFAULT_UPDATER_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("RAKAZO_UPDATER_PORT is not a port number.");
  }
  return {
    deployDir,
    composeFile: path.posix.join(deployDir, composeFile),
    envFile: path.posix.join(deployDir, ".env"),
    projectName: resolveComposeProjectName(env),
    image,
    token: resolveUpdaterToken(env),
    host: env.RAKAZO_UPDATER_HOST?.trim() || "127.0.0.1",
    port,
  };
}

/**
 * Reads one assignment out of a `.env` file the way Compose does: later assignments win, comments
 * and blank lines are ignored, and one layer of quoting is removed.
 */
export function readEnvAssignment(contents: string, key: string): string | null {
  let found: string | null = null;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0 || line.slice(0, separator).trim() !== key) continue;
    const value = line.slice(separator + 1).trim();
    found = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return found;
}

export interface TagState {
  currentTag: string;
  previousTag: string | null;
}

/** What the deployment is pinned to now, ignoring anything in the file that is not a usable tag. */
export function readTagState(envContents: string): TagState {
  const current = readEnvAssignment(envContents, IMAGE_TAG_ENV);
  const previous = readEnvAssignment(envContents, PREVIOUS_IMAGE_TAG_ENV);
  return {
    currentTag: current !== null && isValidImageTag(current) ? current : DEFAULT_IMAGE_TAG,
    previousTag: previous !== null && isValidImageTag(previous) ? previous : null,
  };
}

export function truncateOutput(value: string): string {
  const text = value.trimEnd();
  if (text.length <= MAX_STEP_OUTPUT) return text;
  return `…${text.slice(-MAX_STEP_OUTPUT)}`;
}

/**
 * The sidecar answers with a plain reason when it will not act, so the API can surface it as a bad
 * request instead of an opaque 500.
 */
export class UpdateRefused extends Error {}
