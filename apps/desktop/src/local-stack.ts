import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopLocalStackState } from "@rakazo/contracts";
import {
  classifyDockerFailure,
  composeSupportsWaitTimeout,
  type DockerFailureKind,
  dockerSpawnEnv,
  type RunDocker,
  type RunDockerResult,
  resolveDockerBinary,
} from "./docker-cli.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const STACK_DIR_NAME = "stack";
export const STACK_COMPOSE_FILE = "docker-compose.images.yml";
export const STACK_ENV_TEMPLATE = ".env.images.example";
export const STACK_ENV_FILE = ".env";
export const STACK_TOKEN_FILE = ".desktop-stack-token";
export const STACK_OUTPUT_LINES = 20;
export const STACK_HEALTH_TIMEOUT_MS = 120_000;
export const COMPOSE_WAIT_TIMEOUT_S = 300;

const HEALTH_POLL_INTERVAL_MS = 2_000;
const COMPOSE_VERSION_TIMEOUT_MS = 15_000;
const DOCKER_INFO_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const UP_TIMEOUT_MS = (COMPOSE_WAIT_TIMEOUT_S + 60) * 1_000;
const LOGS_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 90_000;
const MAX_STACK_TOKEN_BYTES = 1024;

/** The compose project lives under the app's user data, next to the `.env` it generates. */
export function stackDir(userDataDir: string): string {
  return path.join(userDataDir, STACK_DIR_NAME);
}

/** Installed builds ship the compose YAML and env template as extra resources outside asar. */
export function stackResourceDir(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  if (input.packaged) return path.join(input.resourcesPath, STACK_DIR_NAME);
  return path.resolve(input.appPath, "..", "..", "infra", "compose");
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Installed builds pin images to their own version so the DMG and the multi-arch
 * images move together; development builds follow `edge`.
 */
export function resolveImageTag(input: {
  version: string;
  packaged: boolean;
  override?: string;
}): string {
  const override = input.override?.trim();
  if (override) return override;
  if (input.packaged && STABLE_VERSION.test(input.version)) return `v${input.version}`;
  return "edge";
}

const GENERATED_SECRETS: Record<string, number> = {
  POSTGRES_PASSWORD: 16,
  BETTER_AUTH_SECRET: 32,
  ENCRYPTION_KEY: 32,
  SCREEN_PROXY_SECRET: 32,
  SANDBOX_SUPERVISOR_TOKEN: 32,
};
const LAUNCH_SUPPLIED = ["RAKAZO_IMAGE_TAG", "RAKAZO_COMPUTER_IMAGE_TAG"];

/**
 * Port of install-images.sh `create_env`: fills the empty secret lines with random
 * hex and keeps everything else verbatim. Image tags are dropped because the app
 * supplies them per launch, so an update never leaves a stale pin behind.
 */
export function renderStackEnv(template: string, randomHex: (bytes: number) => string): string {
  const lines = template.split("\n");
  const rendered: string[] = [];
  for (const line of lines) {
    const separator = line.indexOf("=");
    const name = separator === -1 ? "" : line.slice(0, separator);
    if (line === `${name}=` && Object.hasOwn(GENERATED_SECRETS, name)) {
      rendered.push(`${name}=${randomHex(GENERATED_SECRETS[name]!)}`);
      continue;
    }
    if (LAUNCH_SUPPLIED.includes(name)) continue;
    rendered.push(line);
  }
  return rendered.join("\n");
}

/** Keeps an existing regular `.env`, but replaces a final symlink instead of trusting its target. */
export async function ensureStackEnv(
  dir: string,
  template: string,
  randomHex: (bytes: number) => string,
): Promise<"kept" | "created"> {
  const destination = path.join(dir, STACK_ENV_FILE);
  try {
    const info = await lstat(destination);
    if (!info.isSymbolicLink()) return "kept";
  } catch {
    // Missing files are created below.
  }
  await writePrivateFile(destination, renderStackEnv(template, randomHex));
  return "created";
}

const STACK_TOKEN = /^[a-f0-9]{64}$/;

export async function readStackToken(dir: string): Promise<string | null> {
  const raw = await readPrivateFile(path.join(dir, STACK_TOKEN_FILE), MAX_STACK_TOKEN_BYTES);
  const token = raw?.trim() ?? "";
  return STACK_TOKEN.test(token) ? token : null;
}

/** Creates an app-private identity without placing it in the user-editable Compose env file. */
export async function ensureStackToken(
  dir: string,
  randomHex: (bytes: number) => string,
): Promise<string> {
  const existing = await readStackToken(dir);
  if (existing !== null) return existing;
  const token = randomHex(32);
  if (!STACK_TOKEN.test(token)) throw new Error("Stack token generator returned invalid data.");
  await writePrivateFile(path.join(dir, STACK_TOKEN_FILE), `${token}\n`);
  return token;
}

export type LocalStackEvent =
  | { type: "check-start" }
  | { type: "docker-missing"; message: string }
  | { type: "docker-not-running"; message: string }
  | { type: "prepare" }
  | { type: "pull-start" }
  | { type: "up-start" }
  | { type: "wait-start" }
  | { type: "output"; line: string }
  | { type: "ready" }
  | { type: "failed"; message: string };

export function initialStackState(imageTag: string): DesktopLocalStackState {
  return { phase: "idle", message: null, output: [], imageTag };
}

export function reduceStackState(
  state: DesktopLocalStackState,
  event: LocalStackEvent,
): DesktopLocalStackState {
  if (event.type === "check-start") {
    return { ...state, phase: "checking-docker", message: null, output: [] };
  }
  // Terminal phases only leave through the next check-start.
  if (state.phase === "ready" || state.phase === "failed") return state;
  switch (event.type) {
    case "docker-missing":
      return { ...state, phase: "docker-missing", message: event.message };
    case "docker-not-running":
      return { ...state, phase: "docker-not-running", message: event.message };
    case "prepare":
      return { ...state, phase: "preparing", message: null };
    case "pull-start":
      return { ...state, phase: "pulling", message: null };
    case "up-start":
      return { ...state, phase: "starting", message: null };
    case "wait-start":
      return { ...state, phase: "waiting-healthy", message: null };
    case "output":
      if (
        state.phase !== "pulling" &&
        state.phase !== "starting" &&
        state.phase !== "waiting-healthy"
      ) {
        return state;
      }
      return { ...state, output: [...state.output, event.line].slice(-STACK_OUTPUT_LINES) };
    case "ready":
      return { ...state, phase: "ready", message: null };
    case "failed":
      return { ...state, phase: "failed", message: event.message };
  }
}

const DOCKER_GROUP_HINT =
  "This user cannot access Docker. Add it to the docker group (sudo usermod -aG docker $USER), sign out and back in, then check again.";
const STOP_FAILED = "Could not stop the local stack. Check that Docker is running, then try again.";
const START_INTERRUPTED = "The start was interrupted. Retry to continue.";

/** Docker output may contain paths and hostnames, so the person only ever sees these. */
export function stackFailureMessage(
  kind: DockerFailureKind,
  phase: "pulling" | "starting",
  imageTag: string,
): string {
  switch (kind) {
    case "image-not-found":
      return `Images for ${imageTag} are not published yet. Try again in a few minutes.`;
    case "port-in-use":
      return "Port 5173 or 3100 is already in use on this computer. Stop what is using it, then retry.";
    case "network":
      return "Could not reach the image registry. Check the internet connection, then retry.";
    case "daemon-down":
      return "Docker stopped answering. Start Docker, then retry.";
    case "socket-permission":
      return DOCKER_GROUP_HINT;
    case "compose-missing":
      return "Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin, then retry.";
    case "other":
      return phase === "pulling"
        ? "Downloading Rakazo images failed. Check the output below, then retry."
        : "Rakazo services did not start. Check the output below, then retry.";
  }
}

function failureKind(result: RunDockerResult): DockerFailureKind {
  return classifyDockerFailure(`${result.stdout}\n${result.stderr}`);
}

/** runDocker exits 130 after an abort; that is a quit or Stop, not a docker failure. */
function interrupted(signal: AbortSignal, result: RunDockerResult): boolean {
  return signal.aborted || result.code === 130;
}

export interface LocalStackDeps {
  platform: string;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  run: RunDocker;
  stackDir: string;
  resourceDir: string;
  localWebUrl: string;
  imageTag: string;
  /** Returns the authenticated running image tag, or null for any other listener. */
  probe: (url: string, signal: AbortSignal, token: string) => Promise<string | null>;
  randomHex: (bytes: number) => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  healthTimeoutMs?: number;
}

/** Resolves early on abort so a stop never waits out a health poll. */
function defaultSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Installs and starts the compose stack under the app's user data. Every docker call
 * uses a fixed argv and an allowlisted environment; the setup window polls `state()`.
 */
export class LocalStackController {
  private current: DesktopLocalStackState;
  private currentStackToken: string | null = null;
  private running: Promise<DesktopLocalStackState> | null = null;
  private stopping: Promise<DesktopLocalStackState> | null = null;
  private inFlight: AbortController | null = null;
  private ticket = 0;
  /** Starts ticketed at or below this were superseded by a later stop and must not run. */
  private voidBefore = 0;

  constructor(private readonly deps: LocalStackDeps) {
    this.current = initialStackState(deps.imageTag);
  }

  state(): DesktopLocalStackState {
    return this.current;
  }

  /** Fast path for launch: only a stack with our private token and desired image may be reused. */
  async matchesDesiredStack(url = this.deps.localWebUrl): Promise<boolean> {
    const token = await readStackToken(this.deps.stackDir);
    if (token === null) return false;
    this.currentStackToken = token;
    try {
      return (
        (await this.deps.probe(url, AbortSignal.timeout(HEALTH_POLL_INTERVAL_MS), token)) ===
        this.deps.imageTag
      );
    } catch {
      return false;
    }
  }

  /**
   * Idempotent while a start is in flight; otherwise begins a fresh attempt from any
   * phase, after any stop still running so `compose up` and `compose stop` never overlap.
   */
  start(): Promise<DesktopLocalStackState> {
    if (this.running !== null) return this.running;
    const ticket = ++this.ticket;
    const attempt = (this.stopping ?? Promise.resolve())
      .then(() => (ticket <= this.voidBefore ? this.current : this.run()))
      .finally(() => {
        if (this.running === attempt) this.running = null;
      });
    this.running = attempt;
    return attempt;
  }

  /** Kills the in-flight docker command; containers already started keep running. */
  abort() {
    this.inFlight?.abort();
  }

  /** Stops the containers (`compose stop`); volumes and images stay for the next start. */
  stop(): Promise<DesktopLocalStackState> {
    this.voidBefore = this.ticket;
    // Join a stop already running unless a start was queued behind it; the latest
    // intent is "stopped", so that start is voided and a fresh stop follows it.
    if (this.stopping !== null && this.running === null) return this.stopping;
    this.abort();
    // Release the attempt now so a start requested during this stop queues a fresh
    // attempt behind it instead of joining the one being torn down.
    const settled = [this.stopping, this.running].map((pending) => pending?.catch(() => undefined));
    this.running = null;
    const stopping = Promise.all(settled)
      .then(() => this.runStop())
      .finally(() => {
        if (this.stopping === stopping) this.stopping = null;
      });
    this.stopping = stopping;
    return stopping;
  }

  private async runStop(): Promise<DesktopLocalStackState> {
    const binary = resolveDockerBinary(this.deps.platform, this.deps.env, this.deps.exists);
    const stopped = binary === null ? null : await this.compose(binary, ["stop"], STOP_TIMEOUT_MS);
    this.current =
      stopped?.code === 0
        ? initialStackState(this.deps.imageTag)
        : { ...this.current, phase: "failed", message: STOP_FAILED };
    return this.current;
  }

  private push(event: LocalStackEvent) {
    this.current = reduceStackState(this.current, event);
  }

  private async run(): Promise<DesktopLocalStackState> {
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      await this.attempt(controller.signal);
    } catch {
      // Copying the bundled compose files failed; the path would not help the person.
      this.push({ type: "failed", message: "Could not prepare the local stack. Retry." });
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    return this.current;
  }

  private async attempt(signal: AbortSignal) {
    this.push({ type: "check-start" });
    await mkdir(this.deps.stackDir, { recursive: true, mode: 0o700 });

    const binary = resolveDockerBinary(this.deps.platform, this.deps.env, this.deps.exists);
    if (binary === null) {
      this.push({ type: "docker-missing", message: "Docker is not installed on this computer." });
      return;
    }
    const version = await this.docker(
      binary,
      ["compose", "version", "--short"],
      COMPOSE_VERSION_TIMEOUT_MS,
      signal,
    );
    if (interrupted(signal, version))
      return this.push({ type: "failed", message: START_INTERRUPTED });
    if (version.code !== 0) {
      this.push({
        type: "docker-missing",
        message:
          "Docker is installed, but Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin.",
      });
      return;
    }
    const info = await this.docker(
      binary,
      ["info", "--format", "{{.ServerVersion}}"],
      DOCKER_INFO_TIMEOUT_MS,
      signal,
    );
    if (interrupted(signal, info)) return this.push({ type: "failed", message: START_INTERRUPTED });
    if (info.code !== 0) {
      this.push({
        type: "docker-not-running",
        message:
          failureKind(info) === "socket-permission"
            ? DOCKER_GROUP_HINT
            : "Docker is installed but not running. Start Docker, then check again.",
      });
      return;
    }

    this.push({ type: "prepare" });
    await copyFile(
      path.join(this.deps.resourceDir, STACK_COMPOSE_FILE),
      path.join(this.deps.stackDir, STACK_COMPOSE_FILE),
    );
    const template = await readFile(path.join(this.deps.resourceDir, STACK_ENV_TEMPLATE), "utf8");
    await ensureStackEnv(this.deps.stackDir, template, this.deps.randomHex);
    const stackToken = await ensureStackToken(this.deps.stackDir, this.deps.randomHex);
    this.currentStackToken = stackToken;

    this.push({ type: "pull-start" });
    const pulled = await this.compose(binary, ["pull"], PULL_TIMEOUT_MS, signal);
    if (interrupted(signal, pulled))
      return this.push({ type: "failed", message: START_INTERRUPTED });
    if (pulled.code !== 0) {
      this.push({
        type: "failed",
        message: stackFailureMessage(failureKind(pulled), "pulling", this.deps.imageTag),
      });
      return;
    }

    this.push({ type: "up-start" });
    const upArgs = composeSupportsWaitTimeout(version.stdout)
      ? ["up", "-d", "--wait", "--wait-timeout", String(COMPOSE_WAIT_TIMEOUT_S)]
      : ["up", "-d"];
    const up = await this.compose(binary, upArgs, UP_TIMEOUT_MS, signal);
    if (interrupted(signal, up)) return this.push({ type: "failed", message: START_INTERRUPTED });
    if (up.code !== 0) {
      // Best effort: recent service logs usually name the failing service.
      await this.compose(binary, ["logs", "--tail", "30", "--no-color"], LOGS_TIMEOUT_MS, signal);
      this.push({
        type: "failed",
        message: stackFailureMessage(failureKind(up), "starting", this.deps.imageTag),
      });
      return;
    }

    this.push({ type: "wait-start" });
    const sleep = this.deps.sleep ?? defaultSleep;
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? STACK_HEALTH_TIMEOUT_MS);
    while (!signal.aborted) {
      if (
        (await this.deps.probe(this.deps.localWebUrl, signal, stackToken)) === this.deps.imageTag
      ) {
        this.push({ type: "ready" });
        return;
      }
      if (Date.now() >= deadline) break;
      await sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
    this.push({
      type: "failed",
      message: signal.aborted
        ? START_INTERRUPTED
        : "The stack started but the web app did not answer. Retry, and check the output below.",
    });
  }

  private docker(binary: string, args: string[], timeoutMs: number, signal?: AbortSignal) {
    return this.deps.run(binary, args, {
      cwd: this.deps.stackDir,
      env: dockerSpawnEnv(this.deps.platform, this.deps.env, binary, {
        RAKAZO_IMAGE_TAG: this.deps.imageTag,
        RAKAZO_COMPUTER_IMAGE_TAG: this.deps.imageTag,
        ...(this.currentStackToken === null
          ? {}
          : { RAKAZO_DESKTOP_STACK_TOKEN: this.currentStackToken }),
        COMPOSE_PROGRESS: "plain",
      }),
      timeoutMs,
      signal,
      onLine: (line) => this.push({ type: "output", line }),
    });
  }

  private compose(binary: string, args: string[], timeoutMs: number, signal?: AbortSignal) {
    return this.docker(
      binary,
      ["compose", "--env-file", STACK_ENV_FILE, "-f", STACK_COMPOSE_FILE, ...args],
      timeoutMs,
      signal,
    );
  }
}
