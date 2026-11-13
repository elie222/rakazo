import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { DesktopLocalStackState } from "@rakazo/contracts";
import type { DockerFailureKind, RunDocker, RunDockerResult } from "./docker-cli.js";
import {
  classifyDockerFailure,
  composeSupportsWaitTimeout,
  dockerSpawnEnv,
  resolveDockerBinary,
} from "./docker-cli.js";
import { t } from "./i18n.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const STACK_DIR_NAME = "stack";
export const STACK_PROJECT_NAME = "rakazo-desktop";
export const STACK_COMPOSE_FILE = "docker-compose.images.yml";
export const STACK_ENV_TEMPLATE = ".env.images.example";
export const STACK_ENV_FILE = ".env";
export const STACK_WEB_URL_FILE = ".desktop-web-url";
export const STACK_HOST_CONFIG_FILE = ".desktop-host-config";
export const STACK_TOKEN_FILE = ".desktop-stack-token";
export const STACK_OUTPUT_LINES = 20;
export const STACK_HEALTH_TIMEOUT_MS = 120_000;
export const COMPOSE_WAIT_TIMEOUT_S = 300;

export async function readStackWebUrl(dir: string, fallback: string): Promise<string> {
  const raw = await readPrivateFile(path.join(dir, STACK_WEB_URL_FILE), 128);
  const match = raw?.match(/^http:\/\/127\.0\.0\.1:(\d{4,5})$/);
  const port = Number(match?.[1]);
  return match && port >= 1024 && port <= 65535 && raw === `http://127.0.0.1:${port}`
    ? raw
    : fallback;
}

/** Binds and releases `port` on loopback (0 picks a free one); resolves to the port it bound. */
function bindLoopback(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("No loopback port allocated."));
      });
    });
  });
}

/** Docker owns the final bind; a racing listener is handled by bounded up retries. */
export function allocateLoopbackPort(): Promise<number> {
  return bindLoopback(0);
}

export function portFreeOnLoopback(port: number): Promise<boolean> {
  return bindLoopback(port).then(
    () => true,
    () => false,
  );
}

const HEALTH_POLL_INTERVAL_MS = 2_000;
const COMPOSE_VERSION_TIMEOUT_MS = 15_000;
const DOCKER_INFO_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const UP_TIMEOUT_MS = (COMPOSE_WAIT_TIMEOUT_S + 60) * 1_000;
const LOGS_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 90_000;
/** After this long, a Docker app setup opened has likely quit or is waiting on the person. */
const DOCKER_APP_START_GRACE_MS = 90_000;
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
  POSTGRES_APP_PASSWORD: 16,
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

// Secrets a later version added. A stack created before then gets them appended,
// so an update keeps starting (Compose requires them) without touching other lines.
const ADDED_SECRETS = ["POSTGRES_APP_PASSWORD"];

/** Lines to append so an existing `.env` has every added secret, or "" when it already does. */
/** The `.env` assignments as Compose reads them: the last assignment of a name wins. */
export function parseStackEnv(env: string): Map<string, string> {
  const values = new Map<string, string>();
  // Consume quoted values across lines so their contents cannot become assignments.
  const assignments = env.matchAll(
    /^[\t ]*(?:export[\t ]+)?([^\s=#]+)[\t ]*=[\t ]*(?:"((?:\\[\s\S]|[^"\\])*)"(?=[\t ]*(?:#.*)?\r?$)|'((?:\\[\s\S]|[^'\\])*)'(?=[\t ]*(?:#.*)?\r?$)|([^\r\n]*))/gm,
  );
  for (const match of assignments) {
    values.set(match[1]!, match[2] ?? match[3] ?? match[4]!.trim());
  }
  return values;
}

export function missingStackSecrets(env: string, randomHex: (bytes: number) => string): string {
  const values = parseStackEnv(env);
  // Compose uses the last assignment; empty quotes still fail its required-value check.
  return ADDED_SECRETS.filter((name) => (values.get(name) ?? "") === "")
    .map((name) => `${name}=${randomHex(GENERATED_SECRETS[name]!)}\n`)
    .join("");
}

/**
 * Keeps an existing regular `.env` (appending only secrets added since it was
 * created), but replaces a final symlink instead of trusting its target.
 */
export async function ensureStackEnv(
  dir: string,
  template: string,
  randomHex: (bytes: number) => string,
): Promise<"kept" | "created"> {
  const destination = path.join(dir, STACK_ENV_FILE);
  const info = await lstat(destination).catch(() => undefined);
  if (info && !info.isSymbolicLink()) {
    const current = await readFile(destination, "utf8");
    const missing = missingStackSecrets(current, randomHex);
    if (missing) {
      const separator = current === "" || current.endsWith("\n") ? "" : "\n";
      await writePrivateFile(destination, `${current}${separator}${missing}`);
    }
    return "kept";
  }
  // Missing files (and a final symlink) are created below.
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
  | { type: "download"; name: string; bytes: number }
  | { type: "ready" }
  | { type: "failed"; message: string; output?: string[] };

export function initialStackState(imageTag: string): DesktopLocalStackState {
  return { phase: "idle", message: null, output: [], layerBytes: {}, imageTag };
}

/** `COMPOSE_PROGRESS=plain` reports a layer's downloaded size and never its total. */
const PULL_PROGRESS = /^\s*(\S+)\s+Downloading\s+([\d.]+)\s*([kKMG]?B)\b/;
const BYTE_UNITS: Record<string, number> = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9 };

/** Layers report a growing size, so the largest value seen for a layer is what it has pulled. */
function reduceLayerBytes(layerBytes: Record<string, number>, line: string) {
  const match = PULL_PROGRESS.exec(line);
  if (match === null) return layerBytes;
  const layer = match[1] ?? "";
  const unit = match[3] === "KB" ? "kB" : (match[3] ?? "");
  const bytes = Number(match[2]) * (BYTE_UNITS[unit] ?? 0);
  if (!Number.isFinite(bytes) || bytes <= (layerBytes[layer] ?? 0)) return layerBytes;
  return { ...layerBytes, [layer]: bytes };
}

export function reduceStackState(
  state: DesktopLocalStackState,
  event: LocalStackEvent,
): DesktopLocalStackState {
  if (event.type === "check-start") {
    return { ...state, phase: "checking-docker", message: null, output: [], layerBytes: {} };
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
      return {
        ...state,
        output: [...state.output, event.line].slice(-STACK_OUTPUT_LINES),
        layerBytes: reduceLayerBytes(state.layerBytes, event.line),
      };
    case "download":
      if (state.phase !== "pulling" || event.bytes <= (state.layerBytes[event.name] ?? 0)) {
        return state;
      }
      return { ...state, layerBytes: { ...state.layerBytes, [event.name]: event.bytes } };
    case "ready":
      return { ...state, phase: "ready", message: null };
    case "failed":
      return {
        ...state,
        phase: "failed",
        message: event.message,
        output: [...state.output, ...(event.output ?? [])].slice(-STACK_OUTPUT_LINES),
      };
  }
}

const dockerGroupHint = () =>
  t(
    "This user cannot access Docker. Add it to the docker group (sudo usermod -aG docker $USER), then sign out and back in.",
  );
export const startInterrupted = () => t("The start was interrupted. Retry to continue.");

/** Docker output may contain paths and hostnames, so the person only ever sees these. */
export function stackFailureMessage(
  kind: DockerFailureKind,
  phase: "pulling" | "starting",
  imageTag: string,
): string {
  switch (kind) {
    case "image-not-found":
      return t("Images for {tag} are not published yet. Try again in a few minutes.", {
        tag: imageTag,
      });
    case "port-in-use":
      return t("Could not bind a local port after retrying. Retry to choose another port.");
    case "address-pool-exhausted":
      return t(
        "Docker has no free network address pools. Remove unused Docker networks or expand Docker’s address pools, then retry.",
      );
    case "network":
      return t("Could not reach the image registry. Check the internet connection, then retry.");
    case "daemon-down":
      return t("Docker stopped answering. Start Docker, then retry.");
    case "socket-permission":
      return dockerGroupHint();
    case "compose-missing":
      return t(
        "Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin, then retry.",
      );
    case "other":
      return phase === "pulling"
        ? t("Downloading Rakazo images failed. Check the output below, then retry.")
        : t("Rakazo services did not start. Check the output below, then retry.");
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
  hostComputer?: { url: string; token: string };
  platform: string;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  run: RunDocker;
  /** Starts the app that owns `binary` (Docker Desktop, OrbStack); resolves to its name, or null. */
  launchDockerApp?: (binary: string) => Promise<string | null>;
  now?: () => number;
  stackDir: string;
  resourceDir: string;
  localWebUrl: string;
  allocatePort?: () => Promise<number>;
  imageTag: string;
  /** Returns the authenticated running image tag, or null for any other listener. */
  probe: (url: string, signal: AbortSignal, token: string) => Promise<string | null>;
  randomHex: (bytes: number) => string;
  /** Called on every state change so the setup window is pushed progress instead of polling for it. */
  onState?: (state: DesktopLocalStackState) => void;
  /** Called when a reuse probe confirms a running stack without a phase change, so dependent UI can refresh. */
  onReuseConfirmed?: () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  healthTimeoutMs?: number;
}

/** What the app needs from whichever controller runs This computer. */
export interface StackController {
  webUrl(): string;
  state(): DesktopLocalStackState;
  matchesDesiredStack(): Promise<boolean>;
  /** True while a stack this app manages may still be running, so the menu offers its off-switch. */
  managedStackRunning(): boolean;
  start(): Promise<DesktopLocalStackState>;
  stop(): Promise<DesktopLocalStackState>;
  abort(): void;
}

/** Resolves early on abort so a stop never waits out a health poll. */
export function defaultSleep(ms: number, signal: AbortSignal) {
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
 * The start/stop lifecycle both controllers share: one attempt at a time, a stop that cancels
 * it and voids starts queued before it, and state pushed on every change. Each backend supplies
 * the attempt, how a thrown attempt fails, and what stopping does.
 */
export abstract class StackLifecycle implements StackController {
  protected current: DesktopLocalStackState;
  protected currentWebUrl: string;
  private running: Promise<DesktopLocalStackState> | null = null;
  private stopping: Promise<DesktopLocalStackState> | null = null;
  private inFlight: AbortController | null = null;
  private ticket = 0;
  /** Starts ticketed at or below this were superseded by a later stop and must not run. */
  private voidBefore = 0;

  constructor(
    imageTag: string,
    webUrl: string,
    private readonly onState?: (state: DesktopLocalStackState) => void,
  ) {
    this.current = initialStackState(imageTag);
    this.currentWebUrl = webUrl;
  }

  abstract matchesDesiredStack(): Promise<boolean>;
  abstract managedStackRunning(): boolean;
  protected abstract attempt(signal: AbortSignal): Promise<void>;
  protected abstract attemptFailed(error: unknown, signal: AbortSignal): Promise<void>;
  protected abstract shutdown(): Promise<void>;

  webUrl(): string {
    return this.currentWebUrl;
  }

  state(): DesktopLocalStackState {
    return this.current;
  }

  /**
   * Idempotent while a start is in flight; otherwise begins a fresh attempt from any
   * phase, after any stop still running so a start and a stop never overlap.
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

  /** True while a stop is tearing the stack down, so a probe's answer would already be stale. */
  protected stopInFlight(): boolean {
    return this.stopping !== null;
  }

  /** Cancels the in-flight step; whatever already started keeps running. */
  abort() {
    this.inFlight?.abort();
  }

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
      .then(() => this.shutdown())
      .then(() => this.current)
      .finally(() => {
        if (this.stopping === stopping) this.stopping = null;
      });
    this.stopping = stopping;
    return stopping;
  }

  protected push(event: LocalStackEvent) {
    this.setState(reduceStackState(this.current, event));
  }

  protected setState(next: DesktopLocalStackState) {
    if (next === this.current) return;
    this.current = next;
    this.onState?.(next);
  }

  private async run(): Promise<DesktopLocalStackState> {
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      await this.attempt(controller.signal);
    } catch (error) {
      await this.attemptFailed(error, controller.signal);
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    return this.current;
  }
}

/**
 * Installs and starts the compose stack under the app's user data. Every docker call
 * uses a fixed argv and an allowlisted environment; the setup window polls `state()`.
 */
export class LocalStackController extends StackLifecycle {
  private currentStackToken: string | null = null;
  /** Set once setup has tried to start the Docker app, so a re-check never reopens it on top of the person's work. */
  private dockerAppLaunch: { app: string | null; at: number } | undefined;
  /** True once `compose up` may have left containers running, or a launch probe confirmed
   * a reusable stack; retries and failures keep it, and only a successful stop clears it. */
  private managedStackMayRun = false;
  /** Bumped when a stop succeeds, where the running flag clears; a probe started before
   * that success cannot record reuse afterwards, and a failed stop keeps the stack a candidate. */
  private stopGeneration = 0;

  constructor(private readonly deps: LocalStackDeps) {
    super(deps.imageTag, deps.localWebUrl, deps.onState);
  }

  /**
   * True while a stack this app manages may have containers running: one whose `compose up`
   * ran this session (also across retries and later failures), or one whose reuse a launch
   * probe confirmed. Early failures never started a container, so the desktop's stack
   * off-switch stays hidden for them.
   */
  managedStackRunning(): boolean {
    return this.managedStackMayRun;
  }

  /** Fast path for launch: only a stack with our private token and desired image may be reused. */
  async matchesDesiredStack(url = this.currentWebUrl): Promise<boolean> {
    if (
      this.deps.hostComputer &&
      (await readPrivateFile(path.join(this.deps.stackDir, STACK_HOST_CONFIG_FILE), 256)) !==
        this.hostConfigIdentity()
    )
      return false;
    return this.probeStack((probed) => probed === this.deps.imageTag, url);
  }

  /**
   * Startup rediscovery behind a saved external server: the stack may be an older release
   * this app must not reuse, or one started before the computer-access settings changed, so
   * inspect the managed Compose project locally without sending its token to a listener.
   * nothing starts or stops.
   */
  async rediscoverManagedStack(): Promise<boolean> {
    const generation = this.stopGeneration;
    if (this.stopInFlight()) return false;
    const binary = resolveDockerBinary(this.deps.platform, this.deps.env, this.deps.exists);
    const token = await readStackToken(this.deps.stackDir);
    if (binary === null || token === null) return false;
    try {
      const result = await this.compose(
        binary,
        ["ps", "--status", "running", "-q"],
        HEALTH_POLL_INTERVAL_MS,
      );
      if (result.code !== 0 || !result.stdout.trim()) return false;
      const inspected = await this.docker(
        binary,
        ["inspect", "--format", "{{json .Config.Env}}", ...result.stdout.trim().split(/\s+/)],
        HEALTH_POLL_INTERVAL_MS,
        undefined,
        true,
      );
      const running =
        inspected.code === 0 &&
        inspected.stdout
          .trim()
          .split("\n")
          .some((line) => {
            const env: unknown = JSON.parse(line);
            return Array.isArray(env) && env.includes(`RAKAZO_DESKTOP_STACK_TOKEN=${token}`);
          });
      if (running && generation === this.stopGeneration && !this.managedStackMayRun) {
        this.managedStackMayRun = true;
        this.deps.onReuseConfirmed?.();
      }
      return running;
    } catch {
      return false;
    }
  }

  /** One probe through the private identity; `matches` decides what counts and is returned. */
  private async probeStack(
    matches: (probed: string | null) => boolean,
    url: string,
  ): Promise<boolean> {
    // Captured before the first await, so a stop that succeeds during the token read
    // still counts as later than this probe.
    const stopGeneration = this.stopGeneration;
    if (this.stopInFlight()) return false;
    const token = await readStackToken(this.deps.stackDir);
    if (token === null) return false;
    this.currentStackToken = token;
    try {
      const probed = await this.deps.probe(
        url,
        AbortSignal.timeout(HEALTH_POLL_INTERVAL_MS),
        token,
      );
      const matched = matches(probed);
      // A stop that succeeded while the probe was pending may have stopped the stack it saw.
      if (matched && stopGeneration === this.stopGeneration && !this.managedStackMayRun) {
        this.managedStackMayRun = true;
        // The phase stays idle, so no lifecycle event follows; announce the flip itself.
        this.deps.onReuseConfirmed?.();
      }
      return matched;
    } catch {
      return false;
    }
  }

  /** Stops the containers (`compose stop`); volumes and images stay for the next start. */
  protected async shutdown() {
    const binary = resolveDockerBinary(this.deps.platform, this.deps.env, this.deps.exists);
    const stopped = binary === null ? null : await this.compose(binary, ["stop"], STOP_TIMEOUT_MS);
    if (stopped?.code === 0) {
      this.stopGeneration += 1;
      this.managedStackMayRun = false;
    }
    this.setState(
      stopped?.code === 0
        ? initialStackState(this.deps.imageTag)
        : {
            ...this.current,
            phase: "failed",
            message: t(
              "Could not stop the local stack. Check that Docker is running, then try again.",
            ),
          },
    );
  }

  protected async attemptFailed() {
    // Copying the bundled compose files failed; the path would not help the person.
    this.push({ type: "failed", message: t("Could not prepare the local stack. Retry.") });
  }

  protected async attempt(signal: AbortSignal) {
    this.push({ type: "check-start" });
    await mkdir(this.deps.stackDir, { recursive: true, mode: 0o700 });

    const binary = resolveDockerBinary(this.deps.platform, this.deps.env, this.deps.exists);
    if (binary === null) {
      this.push({
        type: "docker-missing",
        message:
          this.deps.platform === "linux"
            ? t("Rakazo needs Docker to run on this computer.")
            : t("Rakazo needs Docker Desktop to run on this computer."),
      });
      return;
    }
    const version = await this.docker(
      binary,
      ["compose", "version", "--short"],
      COMPOSE_VERSION_TIMEOUT_MS,
      signal,
    );
    if (interrupted(signal, version))
      return this.push({ type: "failed", message: startInterrupted() });
    if (version.code !== 0) {
      if (failureKind(version) === "compose-missing") {
        // Docker itself is installed, so the Docker download would not help.
        this.push({
          type: "failed",
          message: t(
            "Docker is installed, but Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin.",
          ),
        });
      } else {
        this.push({
          type: "failed",
          message: t("Could not check Docker Compose. Check the output below, then retry."),
          output: [
            ...`${version.stdout}\n${version.stderr}`.split(/\r?\n/).filter((line) => line !== ""),
            `docker compose version --short exited with code ${version.code}.`,
          ],
        });
      }
      return;
    }
    const info = await this.docker(
      binary,
      ["info", "--format", "{{.ServerVersion}}"],
      DOCKER_INFO_TIMEOUT_MS,
      signal,
    );
    if (interrupted(signal, info))
      return this.push({ type: "failed", message: startInterrupted() });
    if (info.code !== 0) {
      if (failureKind(info) === "socket-permission") {
        this.push({ type: "docker-not-running", message: dockerGroupHint() });
        return;
      }
      const now = this.deps.now ?? Date.now;
      if (this.dockerAppLaunch === undefined) {
        // A daemon chosen by DOCKER_HOST or another context is not the app behind this CLI.
        const app = usesLocalDaemon(this.deps.env)
          ? ((await this.deps.launchDockerApp?.(binary)) ?? null)
          : null;
        this.dockerAppLaunch = { app, at: now() };
      }
      const { app, at } = this.dockerAppLaunch;
      this.push({
        type: "docker-not-running",
        message:
          app !== null && now() - at < DOCKER_APP_START_GRACE_MS
            ? t("Starting {app}…", { app })
            : notRunningMessage(this.deps.platform),
      });
      return;
    }
    // Docker answered; if it is quit later, the next start may open it again.
    this.dockerAppLaunch = undefined;

    this.push({ type: "prepare" });
    await copyFile(
      path.join(this.deps.resourceDir, STACK_COMPOSE_FILE),
      path.join(this.deps.stackDir, STACK_COMPOSE_FILE),
    );
    const template = await readFile(path.join(this.deps.resourceDir, STACK_ENV_TEMPLATE), "utf8");
    await ensureStackEnv(this.deps.stackDir, template, this.deps.randomHex);
    const stackToken = await ensureStackToken(this.deps.stackDir, this.deps.randomHex);
    this.currentStackToken = stackToken;

    const imagesCached = await this.hasLocalReleaseImages(binary, signal);
    if (signal.aborted) return this.push({ type: "failed", message: startInterrupted() });
    if (!imagesCached) {
      this.push({ type: "pull-start" });
      const pulled = await this.compose(binary, ["pull"], PULL_TIMEOUT_MS, signal);
      if (interrupted(signal, pulled))
        return this.push({ type: "failed", message: startInterrupted() });
      if (pulled.code !== 0) {
        this.push({
          type: "failed",
          message: stackFailureMessage(failureKind(pulled), "pulling", this.deps.imageTag),
        });
        return;
      }
    }

    const upArgs = composeSupportsWaitTimeout(version.stdout)
      ? ["up", "-d", "--wait", "--wait-timeout", String(COMPOSE_WAIT_TIMEOUT_S)]
      : ["up", "-d"];
    await writePrivateFile(path.join(this.deps.stackDir, STACK_WEB_URL_FILE), this.currentWebUrl);
    // `compose up` may leave containers running even when it fails or is aborted midway;
    // set before the up-start push so the menu that push rebuilds already sees it.
    this.managedStackMayRun = true;
    this.push({ type: "up-start" });
    let up = await this.compose(binary, upArgs, UP_TIMEOUT_MS, signal);
    for (
      let retry = 0;
      retry < 2 && !interrupted(signal, up) && up.code !== 0 && failureKind(up) === "port-in-use";
      retry += 1
    ) {
      const port = await (this.deps.allocatePort ?? allocateLoopbackPort)();
      if (signal.aborted) break;
      this.currentWebUrl = `http://127.0.0.1:${port}`;
      await writePrivateFile(path.join(this.deps.stackDir, STACK_WEB_URL_FILE), this.currentWebUrl);
      up = await this.compose(binary, upArgs, UP_TIMEOUT_MS, signal);
    }
    if (interrupted(signal, up)) return this.push({ type: "failed", message: startInterrupted() });
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
      if ((await this.deps.probe(this.currentWebUrl, signal, stackToken)) === this.deps.imageTag) {
        if (this.deps.hostComputer)
          await writePrivateFile(
            path.join(this.deps.stackDir, STACK_HOST_CONFIG_FILE),
            this.hostConfigIdentity(),
          );
        this.push({ type: "ready" });
        return;
      }
      if (Date.now() >= deadline) break;
      await sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
    this.push({
      type: "failed",
      message: signal.aborted
        ? startInterrupted()
        : t("The stack started but the web app did not answer. Retry, and check the output below."),
    });
  }

  private async hasLocalReleaseImages(binary: string, signal: AbortSignal): Promise<boolean> {
    // Moving tags must still check the registry for newer images.
    if (!this.deps.imageTag.startsWith("v") || !STABLE_VERSION.test(this.deps.imageTag.slice(1)))
      return false;
    const config = await this.compose(
      binary,
      ["config", "--images"],
      DOCKER_INFO_TIMEOUT_MS,
      signal,
    );
    if (interrupted(signal, config) || config.code !== 0) return false;
    const images = [...new Set(config.stdout.split(/\s+/).filter(Boolean))];
    if (images.length === 0) return false;
    const inspected = await this.docker(
      binary,
      ["image", "inspect", "--format", "{{.Id}}", ...images],
      DOCKER_INFO_TIMEOUT_MS,
      signal,
    );
    return !interrupted(signal, inspected) && inspected.code === 0;
  }

  private hostConfigIdentity() {
    return createHash("sha256").update(JSON.stringify(this.deps.hostComputer)).digest("hex");
  }

  private docker(
    binary: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    quiet = false,
  ) {
    return this.deps.run(binary, args, {
      cwd: this.deps.stackDir,
      env: dockerSpawnEnv(this.deps.platform, this.deps.env, binary, {
        SANDBOX_HOST_URL: this.deps.hostComputer?.url ?? "",
        SANDBOX_HOST_TOKEN: this.deps.hostComputer?.token ?? "",
        RAKAZO_IMAGE_TAG: this.deps.imageTag,
        RAKAZO_COMPUTER_IMAGE_TAG: this.deps.imageTag,
        // Restricted egress needs host iptables rules. Docker Desktop keeps its
        // bridges inside its VM where the host cannot add them, and the app cannot
        // install root firewall rules on Linux either, so the stack would refuse
        // every computer. This computer is the person's own machine.
        SANDBOX_COMPUTER_EGRESS: "open",
        // Content stays on this computer, under its own disk encryption; a lost key
        // would otherwise lose every conversation. Existing ciphertext still reads.
        CONTENT_ENCRYPTION: "off",
        // Only this computer can reach the stack, so its own model and tool servers are fair game.
        MCP_ALLOW_PRIVATE_ENDPOINT: "true",
        ...(this.currentStackToken === null
          ? {}
          : { RAKAZO_DESKTOP_STACK_TOKEN: this.currentStackToken }),
        RAKAZO_WEB_PORT: new URL(this.currentWebUrl).port || "80",
        // Only web needs a stable host address. Docker allocates the API host port.
        RAKAZO_API_PORT: "0",
        BETTER_AUTH_URL: this.currentWebUrl,
        WEB_ORIGIN: this.currentWebUrl,
        API_URL: this.currentWebUrl,
        COMPOSE_PROGRESS: "plain",
      }),
      timeoutMs,
      signal,
      onLine: quiet ? undefined : (line) => this.push({ type: "output", line }),
    });
  }

  private compose(binary: string, args: string[], timeoutMs: number, signal?: AbortSignal) {
    return this.docker(
      binary,
      [
        "compose",
        "--env-file",
        STACK_ENV_FILE,
        "-f",
        STACK_COMPOSE_FILE,
        "--project-name",
        STACK_PROJECT_NAME,
        ...args,
      ],
      timeoutMs,
      signal,
    );
  }
}

/** Contexts Docker Desktop and OrbStack create for their own local daemon. */
const LOCAL_DOCKER_CONTEXTS = new Set(["default", "desktop-linux", "orbstack"]);

function usesLocalDaemon(env: NodeJS.ProcessEnv): boolean {
  if (env.DOCKER_HOST?.trim()) return false;
  const context = env.DOCKER_CONTEXT?.trim();
  return !context || LOCAL_DOCKER_CONTEXTS.has(context);
}

/** Linux runs Docker Engine as a service, which is started rather than opened. */
function notRunningMessage(platform: string): string {
  return platform === "linux"
    ? t("Docker is installed but not running. Start the Docker service to continue.")
    : t("Docker is installed but not running. Open it to continue.");
}
