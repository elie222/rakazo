// This computer without Docker: the database, API, worker and web run as the person's own
// processes on loopback, and bot computers run as VMs through the `local-vm` sandbox provider.
// Drives the same state and events as the Docker controller, so the setup screen is unchanged.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WriteStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopLocalStackState } from "@rakazo/contracts";
import type { RunDocker } from "./docker-cli.js";
import { t } from "./i18n.js";
import {
  allocateLoopbackPort,
  defaultSleep,
  ensureStackEnv,
  ensureStackToken,
  initialStackState,
  parseStackEnv,
  portFreeOnLoopback,
  readStackToken,
  STACK_ENV_FILE,
  STACK_ENV_TEMPLATE,
  STACK_HEALTH_TIMEOUT_MS,
  STACK_OUTPUT_LINES,
  STACK_WEB_URL_FILE,
  StackLifecycle,
  startInterrupted,
} from "./local-stack.js";
import type {
  ContainerRuntime,
  Fetch,
  RuntimeDeps,
  ServerBundle,
  ServerManifest,
} from "./mac-runtime.js";
import {
  CONTAINER_RUNTIME_VERSION,
  DownloadError,
  installPostgres,
  installServerBundle,
  POSTGRES_VERSION,
  pruneRuntimes,
  RuntimeTooOldError,
  resolveContainerRuntime,
} from "./mac-runtime.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const NATIVE_PORTS_FILE = ".native-ports";
export const POSTGRES_DIR = "postgres";
/** The cluster's owner. Fixed, so it can never be the runtime login whatever the `.env` names. */
const NATIVE_OWNER = "rakazo";
/** Written into the cluster once a Docker move has copied everything, so a cut-short move reruns. */
const DOCKER_IMPORTED = ".docker-imported";
const COMPUTER_IMAGE = "ghcr.io/elie222/rakazo/computer";
const POSTGRES_READY = "database system is ready to accept connections";
const HEALTH_POLL_INTERVAL_MS = 1_000;
const POSTGRES_READY_TIMEOUT_MS = 60_000;
const MIGRATE_TIMEOUT_MS = 10 * 60_000;
const INIT_TIMEOUT_MS = 2 * 60_000;
const IMAGE_PULL_TIMEOUT_MS = 60 * 60_000;
const STOP_GRACE_MS = 10_000;
/** A process that stayed up this long starts its next crash from the shortest delay again. */
const STABLE_RUN_MS = 60_000;
const LOG_TAIL_LINES = 12;

/** Doubles from one second up to thirty, so a crash loop never spins. */
export function restartDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 30_000);
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => ChildProcess;

const spawnProcess: SpawnProcess = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], shell: false });

interface ServiceSpec {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Postgres shuts down fast, and cleanly, on SIGINT. */
  stopSignal: NodeJS.Signals;
}

/** One supervised process: output to its log file, restarted with backoff while the stack is up. */
class Service {
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private stopping = false;
  private attempts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private lineListeners = new Set<(line: string) => void>();
  private exitListeners = new Set<() => void>();
  readonly tail: string[] = [];

  constructor(
    readonly spec: ServiceSpec,
    private readonly ctx: {
      spawn: SpawnProcess;
      logDir: string;
      runDir: string;
      /** Called when the process exits unexpectedly; returns whether to restart it. */
      onCrash: (service: Service) => boolean;
    },
  ) {}

  get alive(): boolean {
    return this.child !== null;
  }

  start() {
    this.stopping = false;
    const startedAt = Date.now();
    this.log ??= createWriteStream(path.join(this.ctx.logDir, `${this.spec.name}.log`), {
      flags: "a",
      mode: 0o600,
    });
    const child = this.ctx.spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env,
    });
    this.child = child;
    if (child.pid)
      void writeFile(this.pidFile(), `${child.pid}\n`, { mode: 0o600 }).catch(() => {});
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream?.setEncoding("utf8");
      stream?.on("data", (text: string) => {
        this.log?.write(text);
        const parts = (pending + text).split(/\r?\n/);
        pending = parts.pop() ?? "";
        for (const line of parts) this.line(line);
      });
    }
    child.once("error", (error) => this.line(error.message));
    // A process that fails to spawn emits `close` but never `exit`.
    child.once("exit", () => this.settle(child, startedAt));
    child.once("close", () => this.settle(child, startedAt));
  }

  /** Runs once per child, whichever of its exit events comes first. */
  private settle(child: ChildProcess, startedAt: number) {
    if (this.child !== child) return;
    this.child = null;
    for (const listener of this.exitListeners) listener();
    if (this.stopping || !this.ctx.onCrash(this)) return;
    if (Date.now() - startedAt >= STABLE_RUN_MS) this.attempts = 0;
    const delay = restartDelay(this.attempts++);
    this.line(`${this.spec.name} exited; restarting in ${delay / 1000}s`);
    this.restartTimer = setTimeout(() => {
      if (!this.stopping) this.start();
    }, delay);
  }

  /** Resolves on the first line matching `pattern`; rejects if the process exits or time runs out. */
  waitForLine(pattern: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        this.lineListeners.delete(onLine);
        this.exitListeners.delete(onExit);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onLine = (line: string) => {
        if (line.includes(pattern)) done();
      };
      const onExit = () => done(new Error(`${this.spec.name} exited while starting`));
      const onAbort = () => done(new Error("aborted"));
      const timer = setTimeout(() => done(new Error(`${this.spec.name} did not start`)), timeoutMs);
      this.lineListeners.add(onLine);
      this.exitListeners.add(onExit);
      signal.addEventListener("abort", onAbort, { once: true });
      if (!this.alive) onExit();
    });
  }

  async stop(graceMs = STOP_GRACE_MS) {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (child && (child.pid === undefined || child.exitCode !== null || child.signalCode !== null))
      this.settle(child, 0);
    else if (child) {
      const exited = new Promise<void>((resolve) => this.exitListeners.add(resolve));
      child.kill(this.spec.stopSignal);
      const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      await exited;
      clearTimeout(timer);
    }
    await rm(this.pidFile(), { force: true });
    await new Promise<void>((resolve) => (this.log ? this.log.end(resolve) : resolve()));
    this.log = null;
  }

  private line(line: string) {
    this.tail.push(line);
    if (this.tail.length > LOG_TAIL_LINES) this.tail.shift();
    for (const listener of this.lineListeners) listener(line);
  }

  private pidFile() {
    return path.join(this.ctx.runDir, `${this.spec.name}.pid`);
  }
}

interface NativePorts {
  postgres?: number;
  api?: number;
}

export interface DockerImportTarget {
  port: number;
  user: string;
  password: string;
  database: string;
  dataDir: string;
  signal: AbortSignal;
  onLine: (line: string) => void;
}

export interface NativeStackDeps {
  stackDir: string;
  resourceDir: string;
  localWebUrl: string;
  imageTag: string;
  serverBundle: ServerBundle;
  /** Runs the server's JavaScript: Electron's own binary as Node, or Node itself. */
  nodeBinary: string;
  env: NodeJS.ProcessEnv;
  uid: number;
  hostComputer?: { url: string; token: string };
  run: RunDocker;
  fetch: Fetch;
  exists: (file: string) => boolean;
  probe: (url: string, signal: AbortSignal, token: string) => Promise<string | null>;
  randomHex: (bytes: number) => string;
  onState?: (state: DesktopLocalStackState) => void;
  /** Set once the person agreed to move a Docker stack; reruns into a new database until it completes. */
  importFromDocker?: (target: DockerImportTarget) => Promise<void>;
  spawn?: SpawnProcess;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  portFree?: (port: number) => Promise<boolean>;
  allocatePort?: () => Promise<number>;
  healthTimeoutMs?: number;
  installers?: Partial<{
    postgres: (deps: RuntimeDeps) => Promise<string>;
    server: (
      deps: RuntimeDeps,
      bundle: ServerBundle,
    ) => Promise<{ dir: string; manifest: ServerManifest }>;
    containerRuntime: (
      deps: RuntimeDeps & {
        uid: number;
        exists: (file: string) => boolean;
        appRoot: string;
        logRoot: string;
      },
    ) => Promise<ContainerRuntime>;
  }>;
}

/** Process environment the services may inherit; everything else comes from the stack's `.env`. */
const INHERITED_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];
/** `.env` lines only Compose reads; the database owner login never reaches the API or worker. */
const COMPOSE_ONLY =
  /^(?:POSTGRES_\w+|DATABASE_MIGRATION_URL|SANDBOX_SUPERVISOR_TOKEN|RAKAZO_(?:COMPUTER_)?IMAGE(?:_TAG)?|BUSYBOX_IMAGE|RAKAZO_WEB_BIND)$/;
/** What Compose hands the web service from `.env`. */
const WEB_ENV = [
  "RAKAZO_HOST",
  "RAKAZO_ALLOWED_HOSTS",
  "RAKAZO_CSP_SCRIPT_SRC",
  "RAKAZO_CSP_CONNECT_SRC",
  "RAKAZO_THEME",
  "CRISP_WEBSITE_ID",
  "LOG_LEVEL",
  "LOG_FORMAT",
];

/**
 * A saved port is kept while it is free, so the web origin (and its sign-in) survives relaunches.
 * `taken` holds ports already chosen for this start that nothing has bound yet.
 */
export async function choosePort(
  saved: number | undefined,
  portFree: (port: number) => Promise<boolean>,
  allocate: () => Promise<number>,
  taken: number[] = [],
): Promise<number> {
  if (
    saved !== undefined &&
    saved >= 1024 &&
    saved <= 65535 &&
    !taken.includes(saved) &&
    (await portFree(saved))
  )
    return saved;
  let port = await allocate();
  while (taken.includes(port)) port = await allocate();
  return port;
}

class StartFailure extends Error {
  constructor(
    readonly userMessage: string,
    readonly output: string[] = [],
  ) {
    super(userMessage);
  }
}

const downloadFailed = () =>
  t("Downloading Rakazo failed. Check the internet connection, then retry.");
const servicesFailed = () =>
  t("Rakazo services did not start. Check the output below, then retry.");

export class NativeStackController extends StackLifecycle {
  private background: AbortController | null = null;
  private services: Service[] = [];

  constructor(private readonly deps: NativeStackDeps) {
    super(deps.imageTag, deps.localWebUrl, deps.onState);
  }

  /** True while any server process of this app is running, so quitting must stop them first. */
  hasProcesses(): boolean {
    return this.services.some((service) => service.alive);
  }

  /** Only processes this app started count: an orphan from a crashed launch is replaced. */
  async matchesDesiredStack(): Promise<boolean> {
    if (this.current.phase !== "ready" || !this.services.every((service) => service.alive))
      return false;
    const token = await readStackToken(this.deps.stackDir);
    if (token === null) return false;
    try {
      return (
        (await this.deps.probe(this.currentWebUrl, AbortSignal.timeout(2_000), token)) ===
        this.deps.imageTag
      );
    } catch {
      return false;
    }
  }

  /** Stops every process; the database, data and downloads stay for the next start. */
  protected async shutdown() {
    await this.stopServices();
    this.setState(initialStackState(this.deps.imageTag));
  }

  protected async attemptFailed(error: unknown, signal: AbortSignal) {
    await this.stopServices();
    if (signal.aborted) {
      this.push({ type: "failed", message: startInterrupted() });
    } else if (error instanceof StartFailure) {
      this.push({ type: "failed", message: error.userMessage, output: error.output });
    } else {
      this.push({
        type: "failed",
        message: servicesFailed(),
        output: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  private dir(...parts: string[]) {
    return path.join(this.deps.stackDir, ...parts);
  }

  protected async attempt(signal: AbortSignal) {
    this.push({ type: "check-start" });
    await this.stopServices();
    for (const sub of ["runtime", "logs", "run", "data"]) {
      await mkdir(this.dir(sub), { recursive: true, mode: 0o700 });
    }
    this.push({ type: "prepare" });
    const template = await readFile(path.join(this.deps.resourceDir, STACK_ENV_TEMPLATE), "utf8");
    await ensureStackEnv(this.deps.stackDir, template, this.deps.randomHex);
    const stackToken = await ensureStackToken(this.deps.stackDir, this.deps.randomHex);
    const stackEnv = parseStackEnv(await readFile(this.dir(STACK_ENV_FILE), "utf8"));
    await this.stopOrphans(signal);
    await this.rotateLogs();

    this.push({ type: "pull-start" });
    // One failed install cancels the others, so a retry never races them over the same files.
    const installing = new AbortController();
    const runtimeDeps: RuntimeDeps = {
      dir: this.dir("runtime"),
      run: this.deps.run,
      fetch: this.deps.fetch,
      env: this.baseEnv(),
      signal: AbortSignal.any([signal, installing.signal]),
      onBytes: (name, bytes) => this.push({ type: "download", name, bytes }),
      onLine: (line) => this.push({ type: "output", line }),
    };
    const installers = this.deps.installers ?? {};
    let postgresDir: string;
    let server: { dir: string; manifest: ServerManifest };
    let runtime: ContainerRuntime;
    const installs = [
      (installers.postgres ?? installPostgres)(runtimeDeps),
      (installers.server ?? installServerBundle)(runtimeDeps, this.deps.serverBundle),
      (installers.containerRuntime ?? resolveContainerRuntime)({
        ...runtimeDeps,
        uid: this.deps.uid,
        exists: this.deps.exists,
        appRoot: this.dir("vm"),
        logRoot: this.dir("vm-logs"),
      }),
    ] as const;
    try {
      [postgresDir, server, runtime] = await Promise.all(installs);
    } catch (error) {
      installing.abort();
      await Promise.allSettled(installs);
      if (signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof DownloadError) throw new StartFailure(downloadFailed(), [detail]);
      if (error instanceof RuntimeTooOldError)
        throw new StartFailure(
          t("The computer runtime already running is too old. Update or quit it, then retry."),
          [detail],
        );
      throw new StartFailure(servicesFailed(), [detail]);
    }

    this.push({ type: "up-start" });
    const user = NATIVE_OWNER;
    const database = stackEnv.get("POSTGRES_DB") || "rakazo";
    const password = stackEnv.get("POSTGRES_PASSWORD") ?? "";
    const appPassword = stackEnv.get("POSTGRES_APP_PASSWORD") ?? "";
    const imported = this.dir(POSTGRES_DIR, DOCKER_IMPORTED);
    const moving = this.deps.importFromDocker !== undefined && !this.deps.exists(imported);
    if (moving) {
      // A cluster without the marker holds a move that was cut short; start that move over.
      await rm(this.dir(POSTGRES_DIR), { recursive: true, force: true });
      await rm(this.dir("data"), { recursive: true, force: true });
      await mkdir(this.dir("data"), { recursive: true, mode: 0o700 });
    }
    await this.ensureCluster(postgresDir, user, password, database, signal);
    const ports = await this.ports();
    const portFree = this.deps.portFree ?? portFreeOnLoopback;
    const allocate = this.deps.allocatePort ?? allocateLoopbackPort;
    ports.postgres = await choosePort(ports.postgres, portFree, allocate);
    await writePrivateFile(this.dir(NATIVE_PORTS_FILE), JSON.stringify(ports));
    const postgres = this.service({
      name: "postgres",
      command: path.join(postgresDir, "bin", "postgres"),
      args: [
        "-D",
        this.dir(POSTGRES_DIR),
        "-p",
        String(ports.postgres),
        "-c",
        "listen_addresses=127.0.0.1",
        // macOS caps socket paths at 103 bytes, which user data paths exceed.
        "-c",
        "unix_socket_directories=",
      ],
      cwd: this.deps.stackDir,
      env: this.baseEnv(),
      stopSignal: "SIGINT",
    });
    postgres.start();
    await postgres
      .waitForLine(POSTGRES_READY, POSTGRES_READY_TIMEOUT_MS, signal)
      .catch((error: Error) => {
        throw new StartFailure(servicesFailed(), [...postgres.tail, error.message]);
      });

    const at = (login: string, secret: string) =>
      `postgres://${encodeURIComponent(login)}:${encodeURIComponent(secret)}@127.0.0.1:${ports.postgres}/${encodeURIComponent(database)}`;
    if (moving && this.deps.importFromDocker) {
      try {
        await this.deps.importFromDocker({
          port: ports.postgres,
          user,
          password,
          database,
          dataDir: this.dir("data"),
          signal,
          onLine: (line) => this.push({ type: "output", line }),
        });
        await writeFile(imported, "", { mode: 0o600 });
      } catch (error) {
        // A retry imports into a clean database again; the Docker stack is untouched.
        await this.stopServices();
        await rm(this.dir(POSTGRES_DIR), { recursive: true, force: true });
        if (signal.aborted) throw error;
        throw new StartFailure(
          t("Could not move your data from Docker. Check the output below, then retry."),
          [error instanceof Error ? error.message : String(error)],
        );
      }
    }

    const databaseUrl = at("rakazo_app", appPassword);
    const migrated = await this.deps.run(
      this.deps.nodeBinary,
      [path.join(server.dir, server.manifest.entrypoints.migrate)],
      {
        cwd: server.dir,
        env: {
          ...this.nodeEnv(),
          DATABASE_URL: databaseUrl,
          DATABASE_MIGRATION_URL: at(user, password),
          RAKAZO_DB_PACKAGE_DIR: path.join(server.dir, "packages", "db"),
        },
        timeoutMs: MIGRATE_TIMEOUT_MS,
        signal,
        onLine: (line) => this.push({ type: "output", line }),
      },
    );
    if (migrated.code !== 0) throw new StartFailure(servicesFailed());

    ports.api = await choosePort(ports.api, portFree, allocate, [ports.postgres]);
    await writePrivateFile(this.dir(NATIVE_PORTS_FILE), JSON.stringify(ports));
    const webPort = Number(new URL(this.currentWebUrl).port);
    const chosenWeb = await choosePort(webPort, portFree, allocate, [ports.postgres, ports.api]);
    if (chosenWeb !== webPort) this.currentWebUrl = `http://127.0.0.1:${chosenWeb}`;
    await writePrivateFile(this.dir(STACK_WEB_URL_FILE), this.currentWebUrl);

    const computerImage = `${stackEnv.get("RAKAZO_COMPUTER_IMAGE") || COMPUTER_IMAGE}:${this.deps.imageTag}`;
    const appEnv = this.appEnv(stackEnv, {
      DATABASE_URL: databaseUrl,
      LOCAL_VM_CLI: runtime.cli,
      LOCAL_VM_COMPUTER_IMAGE: computerImage,
      RAKAZO_DESKTOP_STACK_TOKEN: stackToken,
    });
    const entry = (name: keyof ServerManifest["entrypoints"]) =>
      path.join(server.dir, server.manifest.entrypoints[name]);
    const node = (name: string, args: string[], env: Record<string, string>) =>
      this.service({
        name,
        command: this.deps.nodeBinary,
        args,
        cwd: server.dir,
        env,
        stopSignal: "SIGTERM",
      });
    const api = node("api", [entry("api")], {
      ...appEnv,
      API_HOST: "127.0.0.1",
      API_PORT: String(ports.api),
      AUTH_PASSWORD_ENABLED: stackEnv.get("AUTH_PASSWORD_ENABLED") || "true",
      AUTH_BREACHED_PASSWORD_CHECK_ENABLED:
        stackEnv.get("AUTH_BREACHED_PASSWORD_CHECK_ENABLED") || "false",
    });
    // Busy runs allocate fast; a larger young generation cuts the worker's garbage collection.
    const worker = node("worker", ["--max-semi-space-size=64", entry("worker")], appEnv);
    const web = node("web", [entry("web")], {
      ...this.nodeEnv(),
      ...Object.fromEntries(
        WEB_ENV.flatMap((name) => {
          const value = stackEnv.get(name);
          return value ? [[name, value]] : [];
        }),
      ),
      API_PROXY_TARGET: `http://127.0.0.1:${ports.api}`,
      SCREEN_PROXY_SECRET: stackEnv.get("SCREEN_PROXY_SECRET") ?? "",
      WEB_HOST: "127.0.0.1",
      WEB_PORT: String(chosenWeb),
      RAKAZO_DESKTOP_STACK_TOKEN: stackToken,
      RAKAZO_IMAGE_TAG: this.deps.imageTag,
    });
    for (const service of [api, worker, web]) service.start();

    this.push({ type: "wait-start" });
    const sleep = this.deps.sleep ?? defaultSleep;
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? STACK_HEALTH_TIMEOUT_MS);
    const crashed = () => this.services.find((service) => !service.alive);
    let apiHealthy = false;
    while (!signal.aborted) {
      const down = crashed();
      if (down)
        throw new StartFailure(servicesFailed(), [...down.tail, `${down.spec.name} exited`]);
      apiHealthy ||= await this.deps
        .fetch(`http://127.0.0.1:${ports.api}/health`, { signal })
        .then((response) => response.ok)
        .catch(() => false);
      if (
        apiHealthy &&
        (await this.deps.probe(this.currentWebUrl, signal, stackToken)) === this.deps.imageTag
      ) {
        this.push({ type: "ready" });
        await pruneRuntimes(this.dir("runtime"), [
          `postgres-${POSTGRES_VERSION}`,
          `container-${CONTAINER_RUNTIME_VERSION}`,
          path.basename(path.dirname(server.dir)),
          ...this.runtimeRoot(runtime.cli),
        ]).catch(() => undefined);
        this.pullComputerImage(runtime.cli, computerImage);
        return;
      }
      if (Date.now() >= deadline) break;
      await sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
    if (signal.aborted) throw new Error("aborted");
    throw new StartFailure(
      t("The stack started but the web app did not answer. Retry, and check the output below."),
      [...api.tail, ...web.tail].slice(-STACK_OUTPUT_LINES),
    );
  }

  /** Our own runtime copy may be an older pinned version still running; keep its directory. */
  private runtimeRoot(cli: string): string[] {
    const root = path.dirname(path.dirname(cli));
    return path.dirname(root) === this.dir("runtime") ? [path.basename(root)] : [];
  }

  /** Created once, in a scratch directory renamed into place, so a half-made cluster never stays. */
  private async ensureCluster(
    postgresDir: string,
    user: string,
    password: string,
    database: string,
    signal: AbortSignal,
  ): Promise<void> {
    const target = this.dir(POSTGRES_DIR);
    if (this.deps.exists(path.join(target, "PG_VERSION"))) return;
    const scratch = this.dir(`.postgres.${randomUUID()}`);
    const passwordFile = this.dir(`.postgres-password.${randomUUID()}`);
    const options = {
      cwd: this.deps.stackDir,
      env: this.baseEnv(),
      timeoutMs: INIT_TIMEOUT_MS,
      signal,
    };
    try {
      await writePrivateFile(passwordFile, `${password}\n`);
      const init = await this.deps.run(
        path.join(postgresDir, "bin", "initdb"),
        [
          "-D",
          scratch,
          "-U",
          user,
          `--pwfile=${passwordFile}`,
          "--auth=scram-sha-256",
          "--encoding=UTF8",
          "--locale-provider=icu",
          "--icu-locale=en-US",
          "--locale=en_US.UTF-8",
        ],
        options,
      );
      if (init.code !== 0)
        throw new StartFailure(servicesFailed(), init.stderr.split("\n").slice(-5));
      // Single-user mode creates the database before anything can connect.
      const created = await this.deps.run(
        path.join(postgresDir, "bin", "postgres"),
        ["--single", "-D", scratch, "postgres"],
        { ...options, input: `CREATE DATABASE "${database.replaceAll('"', '""')}";\n` },
      );
      if (created.code !== 0)
        throw new StartFailure(servicesFailed(), created.stderr.split("\n").slice(-5));
      await rm(target, { recursive: true, force: true });
      await rename(scratch, target);
    } finally {
      await rm(passwordFile, { force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async ports(): Promise<NativePorts> {
    const raw = await readPrivateFile(this.dir(NATIVE_PORTS_FILE), 256);
    try {
      const parsed = JSON.parse(raw ?? "{}") as NativePorts;
      return {
        postgres: Number.isInteger(parsed.postgres) ? parsed.postgres : undefined,
        api: Number.isInteger(parsed.api) ? parsed.api : undefined,
      };
    } catch {
      return {};
    }
  }

  private service(spec: ServiceSpec): Service {
    const service = new Service(spec, {
      spawn: this.deps.spawn ?? spawnProcess,
      logDir: this.dir("logs"),
      runDir: this.dir("run"),
      // Before the stack is ready a crash fails the start instead.
      onCrash: () => this.current.phase === "ready",
    });
    this.services.push(service);
    return service;
  }

  private async stopServices() {
    this.background?.abort();
    this.background = null;
    const services = this.services;
    this.services = [];
    const database = services.filter((service) => service.spec.name === "postgres");
    await Promise.all(
      services.filter((service) => !database.includes(service)).map((service) => service.stop()),
    );
    await Promise.all(database.map((service) => service.stop(30_000)));
  }

  /** A launch that crashed can leave its processes running; stop any whose command is ours. */
  private async stopOrphans(signal: AbortSignal) {
    const files = await readdir(this.dir("run")).catch(() => [] as string[]);
    // As in a normal stop, the database goes last: a worker that loses it first stops slowly.
    files.sort((a, b) => Number(a === "postgres.pid") - Number(b === "postgres.pid"));
    for (const file of files) {
      if (!file.endsWith(".pid")) continue;
      const pidFile = this.dir("run", file);
      const pid = Number.parseInt((await readPrivateFile(pidFile, 32)) ?? "", 10);
      if (Number.isInteger(pid) && pid > 1) {
        const command = await this.deps.run(
          "/bin/ps",
          ["-ww", "-o", "command=", "-p", String(pid)],
          {
            cwd: this.deps.stackDir,
            env: this.baseEnv(),
            timeoutMs: 5_000,
            signal,
          },
        );
        if (command.code === 0 && command.stdout.includes(this.deps.stackDir)) {
          const stopSignal = file === "postgres.pid" ? "SIGINT" : "SIGTERM";
          await this.killAndWait(pid, stopSignal, signal);
        }
      }
      await rm(pidFile, { force: true });
    }
  }

  private async killAndWait(pid: number, stopSignal: NodeJS.Signals, signal: AbortSignal) {
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const sleep = this.deps.sleep ?? defaultSleep;
    try {
      process.kill(pid, stopSignal);
    } catch {
      return;
    }
    for (let waited = 0; alive() && waited < STOP_GRACE_MS && !signal.aborted; waited += 250) {
      await sleep(250, signal);
    }
    if (alive()) process.kill(pid, "SIGKILL");
  }

  private async rotateLogs() {
    for (const name of ["postgres", "api", "worker", "web"]) {
      await rename(this.dir("logs", `${name}.log`), this.dir("logs", `${name}.previous.log`)).catch(
        () => undefined,
      );
    }
  }

  /** Background download so the first computer starts quickly; the stack does not wait for it. */
  private pullComputerImage(cli: string, image: string) {
    const controller = new AbortController();
    this.background = controller;
    void this.deps
      .run(cli, ["image", "pull", "--progress", "plain", image], {
        cwd: this.deps.stackDir,
        env: this.baseEnv(),
        timeoutMs: IMAGE_PULL_TIMEOUT_MS,
        signal: controller.signal,
      })
      .catch(() => undefined);
  }

  private baseEnv(): Record<string, string> {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    for (const name of INHERITED_ENV) {
      const value = this.deps.env[name];
      if (value) env[name] = value;
    }
    return env;
  }

  /** Electron's binary runs as Node, and the server reads no `.env` of its own. */
  private nodeEnv(): Record<string, string> {
    return {
      ...this.baseEnv(),
      ELECTRON_RUN_AS_NODE: "1",
      RAKAZO_ENV_FILE: "none",
      NODE_ENV: "production",
    };
  }

  /** The API and worker: the person's `.env` (as Compose passes it), then what this stack fixes. */
  private appEnv(
    stackEnv: Map<string, string>,
    fixed: Record<string, string>,
  ): Record<string, string> {
    const fromFile = Object.fromEntries(
      [...stackEnv].filter(([name, value]) => value !== "" && !COMPOSE_ONLY.test(name)),
    );
    return {
      ...fromFile,
      ...this.nodeEnv(),
      DATA_DIR: this.dir("data"),
      WAKEUP_DRIVER: "graphile",
      AGENT_RUNTIME: "pi",
      SANDBOX_PROVIDER: "local-vm",
      // The host bridge is addressed for containers; these processes are on the host itself.
      SANDBOX_HOST_URL: this.deps.hostComputer
        ? this.deps.hostComputer.url.replace("//host.docker.internal:", "//127.0.0.1:")
        : "",
      SANDBOX_HOST_TOKEN: this.deps.hostComputer?.token ?? "",
      // As on Docker: content stays on this computer, under its own disk encryption.
      CONTENT_ENCRYPTION: "off",
      // Only this computer can reach the stack, so its own model and tool servers are fair game.
      MCP_ALLOW_PRIVATE_ENDPOINT: "true",
      BETTER_AUTH_URL: this.currentWebUrl,
      WEB_ORIGIN: this.currentWebUrl,
      API_URL: this.currentWebUrl,
      ...fixed,
    };
  }
}
