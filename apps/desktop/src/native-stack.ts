// This computer without Docker: the API, worker and web run as the person's own processes on
// loopback, the database as the official Postgres image in a VM of its own, and bot computers as
// VMs through the `local-vm` sandbox provider, all through the same computer runtime.
// Drives the same state and events as the Docker controller, so the setup screen is unchanged.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
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
  installServerBundle,
  isInside,
  pruneRuntimes,
  RuntimeTooOldError,
  resolveContainerRuntime,
} from "./mac-runtime.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const NATIVE_PORTS_FILE = ".native-ports";
/** The database VM, its network and its volume; computers are `rakazo-<uuid>` with a bot label. */
export const DATABASE_CONTAINER = "rakazo-postgres";
/** The image and digest Compose runs, so both stacks run the same database. */
export const POSTGRES_IMAGE =
  "postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5";
const POSTGRES_PLATFORM = "linux/arm64";
/** The owner and database. Fixed, so the owner can never be the runtime login whatever the `.env` names. */
const NATIVE_OWNER = "rakazo";
const NATIVE_DATABASE = "rakazo";
/** Written once a Docker move has copied everything, so a cut-short move reruns. */
const DOCKER_IMPORTED = ".docker-imported";
const COMPUTER_IMAGE = "ghcr.io/elie222/rakazo/computer";
const POSTGRES_LISTENING = "listening on IPv4 address";
const POSTGRES_READY = "database system is ready to accept connections";
const HEALTH_POLL_INTERVAL_MS = 1_000;
const POSTGRES_READY_TIMEOUT_MS = 120_000;
const MIGRATE_TIMEOUT_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 60_000;
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
  /** The runtime CLI passes SIGINT to Postgres, which then shuts down fast and cleanly. */
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

  /** Resolves on the first line `matches` accepts; rejects if the process exits or time runs out. */
  waitForLine(
    matches: (line: string) => boolean,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
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
        if (matches(line)) done();
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
  /** Which runtime holds the database's volume: our own copy, or one the person runs. */
  database?: "ours" | "theirs";
}

export interface DockerImportTarget {
  /** The runtime CLI, which runs Postgres's own tools inside the database VM. */
  cli: string;
  container: string;
  env: Record<string, string>;
  user: string;
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
        keepOurs?: boolean;
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
    const ports = await this.ports();
    let server: { dir: string; manifest: ServerManifest };
    let runtime: ContainerRuntime;
    const installs = [
      (installers.server ?? installServerBundle)(runtimeDeps, this.deps.serverBundle),
      (installers.containerRuntime ?? resolveContainerRuntime)({
        ...runtimeDeps,
        uid: this.deps.uid,
        exists: this.deps.exists,
        appRoot: this.dir("vm"),
        logRoot: this.dir("vm-logs"),
        keepOurs: ports.database === "ours",
      }).then(async (resolved) => {
        await this.pullDatabaseImage(resolved.cli, runtimeDeps.signal);
        return resolved;
      }),
    ] as const;
    try {
      [server, runtime] = await Promise.all(installs);
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
    const database = NATIVE_DATABASE;
    const password = stackEnv.get("POSTGRES_PASSWORD") ?? "";
    const appPassword = stackEnv.get("POSTGRES_APP_PASSWORD") ?? "";
    const imported = this.dir(DOCKER_IMPORTED);
    const moving = this.deps.importFromDocker !== undefined && !this.deps.exists(imported);
    if (moving) {
      // Without the marker, files copied by a move that was cut short are copied again.
      await rm(this.dir("data"), { recursive: true, force: true });
      await mkdir(this.dir("data"), { recursive: true, mode: 0o700 });
    }
    const portFree = this.deps.portFree ?? portFreeOnLoopback;
    const allocate = this.deps.allocatePort ?? allocateLoopbackPort;
    const databasePort = await this.ensureDatabase(
      runtime,
      ports,
      password,
      portFree,
      allocate,
      signal,
    );
    const postgres = this.service({
      name: "postgres",
      command: runtime.cli,
      args: ["start", "--attach", DATABASE_CONTAINER],
      cwd: this.deps.stackDir,
      env: this.baseEnv(),
      stopSignal: "SIGINT",
    });
    postgres.start();
    // On first start the image initializes the database on a socket-only server, which reports
    // ready too; the real server is the one that then listens on the network.
    let listening = false;
    await postgres
      .waitForLine(
        (line) => {
          listening ||= line.includes(POSTGRES_LISTENING);
          return listening && line.includes(POSTGRES_READY);
        },
        POSTGRES_READY_TIMEOUT_MS,
        signal,
      )
      .catch((error: Error) => {
        throw new StartFailure(servicesFailed(), [...postgres.tail, error.message]);
      });

    const at = (login: string, secret: string) =>
      `postgres://${encodeURIComponent(login)}:${encodeURIComponent(secret)}@127.0.0.1:${databasePort}/${encodeURIComponent(database)}`;
    if (moving && this.deps.importFromDocker) {
      try {
        // A retry restores into an empty database again; the Docker stack is untouched.
        await this.psql(
          runtime.cli,
          "postgres",
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE);\nCREATE DATABASE ${database};\n`,
          signal,
        );
        await this.deps.importFromDocker({
          cli: runtime.cli,
          container: DATABASE_CONTAINER,
          env: this.baseEnv(),
          user,
          database,
          dataDir: this.dir("data"),
          signal,
          onLine: (line) => this.push({ type: "output", line }),
        });
        await writeFile(imported, "", { mode: 0o600 });
      } catch (error) {
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

    ports.api = await choosePort(ports.api, portFree, allocate, [databasePort]);
    await writePrivateFile(this.dir(NATIVE_PORTS_FILE), JSON.stringify(ports));
    const webPort = Number(new URL(this.currentWebUrl).port);
    const chosenWeb = await choosePort(webPort, portFree, allocate, [databasePort, ports.api]);
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
        // A service that exits while the probe resolves is not restarted, so fail, not report ready.
        const down = crashed();
        if (down)
          throw new StartFailure(servicesFailed(), [...down.tail, `${down.spec.name} exited`]);
        this.push({ type: "ready" });
        await pruneRuntimes(this.dir("runtime"), [
          `container-${CONTAINER_RUNTIME_VERSION}`,
          path.basename(path.dirname(server.dir)),
          ...(await this.runtimeRoot(runtime.cli)),
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
  private async runtimeRoot(cli: string): Promise<string[]> {
    const root = path.dirname(path.dirname(cli));
    return (await isInside(this.dir("runtime"), root)) ? [path.basename(root)] : [];
  }

  /**
   * Leaves the database VM created and stopped, publishing the saved port while it is free. A VM
   * left running by a launch that crashed is stopped first, since the runtime only attaches to a
   * VM it starts. A taken port recreates the VM on a new one; the volume, and so the data, stays.
   * Which runtime holds the database is recorded before anything is created in it, so a launch cut
   * short part-way still points later launches at that runtime.
   */
  private async ensureDatabase(
    runtime: ContainerRuntime,
    ports: NativePorts,
    password: string,
    portFree: (port: number) => Promise<boolean>,
    allocate: () => Promise<number>,
    signal: AbortSignal,
  ) {
    const cli = runtime.cli;
    const holder = runtime.ours ? "ours" : "theirs";
    let existing = await this.inspectDatabase(cli, signal);
    if (existing === null && ports.database !== undefined && ports.database !== holder) {
      throw new StartFailure(
        t("Your Rakazo data is in a different computer runtime. Quit the one running, then retry."),
      );
    }
    if (ports.database === undefined) {
      ports.database = holder;
      await writePrivateFile(this.dir(NATIVE_PORTS_FILE), JSON.stringify(ports));
    }
    if (existing?.running)
      await this.runtimeCommand(cli, ["stop", "--time", "30", DATABASE_CONTAINER], signal);
    const port = await choosePort(existing?.port ?? ports.postgres, portFree, allocate);
    ports.postgres = port;
    if (existing && existing.port !== port) {
      await this.runtimeCommand(cli, ["rm", DATABASE_CONTAINER], signal);
      existing = null;
    }
    if (existing === null) {
      for (const kind of ["network", "volume"]) {
        await this.runtimeCommand(cli, [kind, "create", DATABASE_CONTAINER], signal, {
          exists: true,
        });
      }
      await this.runtimeCommand(
        cli,
        [
          "create",
          "--name",
          DATABASE_CONTAINER,
          "--platform",
          POSTGRES_PLATFORM,
          "--network",
          DATABASE_CONTAINER,
          "--volume",
          `${DATABASE_CONTAINER}:/var/lib/postgresql/data`,
          // The volume's root holds lost+found, which initdb refuses.
          "--env",
          "PGDATA=/var/lib/postgresql/data/pgdata",
          "--env",
          `POSTGRES_USER=${NATIVE_OWNER}`,
          "--env",
          `POSTGRES_DB=${NATIVE_DATABASE}`,
          // Named only, so the value comes from the CLI's environment instead of its arguments.
          "--env",
          "POSTGRES_PASSWORD",
          "--publish",
          `127.0.0.1:${port}:5432`,
          "--memory",
          "1g",
          POSTGRES_IMAGE,
        ],
        signal,
        { env: { POSTGRES_PASSWORD: password } },
      );
    }
    await writePrivateFile(this.dir(NATIVE_PORTS_FILE), JSON.stringify(ports));
    return port;
  }

  private async inspectDatabase(
    cli: string,
    signal: AbortSignal,
  ): Promise<{ running: boolean; port: number | undefined } | null> {
    const result = await this.deps.run(cli, ["inspect", DATABASE_CONTAINER], {
      cwd: this.deps.stackDir,
      env: this.baseEnv(),
      timeoutMs: CLI_TIMEOUT_MS,
      signal,
    });
    if (result.code !== 0) {
      if (/not found/i.test(result.stderr)) return null;
      throw new Error(`container inspect exited with code ${result.code}: ${result.stderr.trim()}`);
    }
    const [record] = JSON.parse(result.stdout || "[]") as {
      configuration?: { publishedPorts?: { containerPort?: number; hostPort?: number }[] };
      status?: { state?: string };
    }[];
    if (!record) return null;
    return {
      running: record.status?.state === "running",
      port: record.configuration?.publishedPorts?.find((entry) => entry.containerPort === 5432)
        ?.hostPort,
    };
  }

  /** Fetches only the image's Apple silicon variant; one already present is not fetched again. */
  private async pullDatabaseImage(cli: string, signal: AbortSignal) {
    const options = { cwd: this.deps.stackDir, env: this.baseEnv(), signal };
    const present = await this.deps.run(cli, ["image", "inspect", POSTGRES_IMAGE], {
      ...options,
      timeoutMs: CLI_TIMEOUT_MS,
    });
    if (present.code === 0) return;
    const pulled = await this.deps.run(
      cli,
      ["image", "pull", "--platform", POSTGRES_PLATFORM, "--progress", "plain", POSTGRES_IMAGE],
      {
        ...options,
        timeoutMs: IMAGE_PULL_TIMEOUT_MS,
        onLine: (line) => this.push({ type: "output", line }),
      },
    );
    if (pulled.code !== 0 && !signal.aborted)
      throw new DownloadError(`Pulling the database image exited with code ${pulled.code}`);
  }

  private async runtimeCommand(
    cli: string,
    args: string[],
    signal: AbortSignal,
    options: { env?: Record<string, string>; exists?: boolean } = {},
  ) {
    const result = await this.deps.run(cli, args, {
      cwd: this.deps.stackDir,
      env: { ...this.baseEnv(), ...options.env },
      timeoutMs: CLI_TIMEOUT_MS,
      signal,
    });
    if (result.code === 0 || (options.exists && /already exists/i.test(result.stderr))) return;
    throw new StartFailure(servicesFailed(), [
      ...result.stderr.trim().split("\n").slice(-3),
      `container ${args.slice(0, 2).join(" ")} exited with code ${result.code}`,
    ]);
  }

  /** Runs SQL as the owner over the VM's own socket, so no password is needed or passed. */
  private async psql(cli: string, database: string, sql: string, signal: AbortSignal) {
    const result = await this.deps.run(
      cli,
      [
        "exec",
        "--interactive",
        DATABASE_CONTAINER,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "-U",
        NATIVE_OWNER,
        "-d",
        database,
      ],
      {
        cwd: this.deps.stackDir,
        env: this.baseEnv(),
        timeoutMs: CLI_TIMEOUT_MS,
        signal,
        input: sql,
      },
    );
    if (result.code !== 0)
      throw new Error(`psql exited with code ${result.code}: ${result.stderr.trim()}`);
  }

  private async ports(): Promise<NativePorts> {
    const raw = await readPrivateFile(this.dir(NATIVE_PORTS_FILE), 256);
    try {
      const parsed = JSON.parse(raw ?? "{}") as NativePorts;
      return {
        postgres: Number.isInteger(parsed.postgres) ? parsed.postgres : undefined,
        api: Number.isInteger(parsed.api) ? parsed.api : undefined,
        database:
          parsed.database === "ours" || parsed.database === "theirs" ? parsed.database : undefined,
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
