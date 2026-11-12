import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDocker } from "./docker-cli.js";
import { STACK_ENV_TEMPLATE, STACK_WEB_URL_FILE } from "./local-stack.js";
import { DownloadError } from "./mac-runtime.js";
import type { NativeStackDeps, SpawnProcess } from "./native-stack.js";
import {
  choosePort,
  NATIVE_PORTS_FILE,
  NativeStackController,
  restartDelay,
} from "./native-stack.js";

const TEMPLATE = `POSTGRES_USER=rakazo
POSTGRES_PASSWORD=
POSTGRES_DB=rakazo
POSTGRES_APP_PASSWORD=
BETTER_AUTH_SECRET=
ENCRYPTION_KEY=
SCREEN_PROXY_SECRET=
SANDBOX_SUPERVISOR_TOKEN=
SANDBOX_PROVIDER=docker
OPENROUTER_API_KEY=sk-or-test
`;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  constructor(
    readonly pid: number | undefined,
    readonly args: string[],
    readonly env: Record<string, string>,
  ) {
    super();
  }
  kill() {
    this.exit();
    return true;
  }
  exit() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
  }
  /** What Node does when the binary cannot be spawned: `error` and `close`, never `exit`. */
  failToSpawn() {
    queueMicrotask(() => {
      this.emit("error", new Error("spawn ENOENT"));
      this.emit("close", -2, null);
    });
  }
}

let stackDir: string;
let resourceDir: string;
beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-"));
  stackDir = path.join(root, "stack");
  resourceDir = path.join(root, "resources");
  await mkdir(resourceDir, { recursive: true });
  await writeFile(path.join(resourceDir, STACK_ENV_TEMPLATE), TEMPLATE);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(path.dirname(stackDir), { recursive: true, force: true });
});

function harness(overrides: Partial<NativeStackDeps> = {}) {
  const children: FakeChild[] = [];
  const runs: { binary: string; args: string[]; env: Record<string, string> }[] = [];
  let nextPid = 1000;
  let nextPort = 40000;
  const spawn: SpawnProcess = (_command, args, options) => {
    const child = new FakeChild(nextPid++, args, options.env);
    children.push(child);
    if (args.includes("listen_addresses=127.0.0.1")) {
      setImmediate(() =>
        child.stderr.write("LOG:  database system is ready to accept connections\n"),
      );
    }
    return child as unknown as ChildProcess;
  };
  const run: RunDocker = async (binary, args, options) => {
    runs.push({ binary, args, env: options.env });
    if (binary.endsWith("initdb")) await mkdir(args[1]!, { recursive: true });
    if (args.includes("--single")) await writeFile(path.join(args[2]!, "PG_VERSION"), "16\n");
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps: NativeStackDeps = {
    stackDir,
    resourceDir,
    localWebUrl: "http://127.0.0.1:5173",
    imageTag: "v1.0.0",
    serverBundle: { version: "1.0.0", file: "/bundle.tar.xz" },
    nodeBinary: "/Applications/Rakazo.app/Contents/MacOS/Rakazo",
    env: { HOME: "/Users/someone", OPENAI_API_KEY: "from-the-shell" },
    uid: 501,
    run,
    fetch: async () => new Response("{}"),
    exists: existsSync,
    probe: async () => "v1.0.0",
    randomHex: (bytes) => "cd".repeat(bytes),
    spawn,
    sleep: async () => undefined,
    portFree: async () => true,
    allocatePort: async () => nextPort++,
    installers: {
      postgres: async () => "/runtime/postgres-16.15.0",
      server: async () => ({
        dir: "/runtime/server-1.0.0/rakazo-server",
        manifest: {
          version: "1.0.0",
          entrypoints: {
            api: "apps/api/dist/index.js",
            worker: "apps/worker/dist/index.js",
            web: "apps/web/dist-server/index.js",
            migrate: "apps/api/dist/cli/migrate-database.js",
          },
        },
      }),
      containerRuntime: async () => ({ cli: "/usr/local/bin/container", ours: false }),
    },
    ...overrides,
  };
  const byName = (entry: string) =>
    children.filter((child) => child.args.some((arg) => arg.endsWith(entry)));
  return { deps, children, runs, byName };
}

describe("restartDelay", () => {
  it("backs off from one second to a thirty second ceiling", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(restartDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });
});

describe("choosePort", () => {
  it("keeps a saved free port and replaces a taken one", async () => {
    const allocate = async () => 45000;
    await expect(choosePort(41000, async () => true, allocate)).resolves.toBe(41000);
    await expect(choosePort(41000, async () => false, allocate)).resolves.toBe(45000);
    await expect(choosePort(undefined, async () => true, allocate)).resolves.toBe(45000);
    await expect(choosePort(80, async () => true, allocate)).resolves.toBe(45000);
  });
});

describe("NativeStackController", () => {
  it("brings up the database, migrations and the three services on loopback", async () => {
    const { deps, runs, byName } = harness({
      hostComputer: { url: "http://host.docker.internal:47000", token: "host-token" },
    });
    const controller = new NativeStackController(deps);
    const state = await controller.start();
    expect(state.phase).toBe("ready");
    await expect(controller.matchesDesiredStack()).resolves.toBe(true);

    const initdb = runs.find((call) => call.binary.endsWith("initdb"));
    expect(initdb?.args).toContain("--auth=scram-sha-256");
    expect(initdb?.args.some((arg) => arg.includes("cdcd"))).toBe(false);
    const migrate = runs.find((call) => call.args[0]?.endsWith("migrate-database.js"));
    expect(migrate?.env.DATABASE_MIGRATION_URL).toBe(
      `postgres://rakazo:${"cd".repeat(16)}@127.0.0.1:40000/rakazo`,
    );
    expect(migrate?.env.DATABASE_URL).toMatch(/^postgres:\/\/rakazo_app:/);
    expect(migrate?.env.RAKAZO_ENV_FILE).toBe("none");

    const [api] = byName("apps/api/dist/index.js");
    expect(api?.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      API_HOST: "127.0.0.1",
      API_PORT: "40001",
      SANDBOX_PROVIDER: "local-vm",
      LOCAL_VM_CLI: "/usr/local/bin/container",
      LOCAL_VM_COMPUTER_IMAGE: "ghcr.io/elie222/rakazo/computer:v1.0.0",
      OPENROUTER_API_KEY: "sk-or-test",
      WEB_ORIGIN: "http://127.0.0.1:5173",
      SANDBOX_HOST_URL: "http://127.0.0.1:47000",
      SANDBOX_HOST_TOKEN: "host-token",
    });
    // The owner login and the person's shell secrets never reach the app.
    expect(api?.env.POSTGRES_PASSWORD).toBeUndefined();
    expect(api?.env.SANDBOX_SUPERVISOR_TOKEN).toBeUndefined();
    expect(api?.env.OPENAI_API_KEY).toBeUndefined();
    const [web] = byName("apps/web/dist-server/index.js");
    expect(web?.env).toMatchObject({
      WEB_PORT: "5173",
      API_PROXY_TARGET: "http://127.0.0.1:40001",
    });
    expect(web?.env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(runs.at(-1)?.args).toEqual([
      "image",
      "pull",
      "--progress",
      "plain",
      "ghcr.io/elie222/rakazo/computer:v1.0.0",
    ]);

    await controller.stop();
    expect(controller.hasProcesses()).toBe(false);
  });

  it("keeps its ports across restarts while they stay free", async () => {
    const first = harness();
    const controller = new NativeStackController(first.deps);
    await controller.start();
    await controller.stop();
    const ports = JSON.parse(await readFile(path.join(stackDir, NATIVE_PORTS_FILE), "utf8"));
    expect(ports).toEqual({ postgres: 40000, api: 40001 });

    const second = harness({ portFree: async (port) => port !== 5173 });
    const again = new NativeStackController(second.deps);
    await again.start();
    expect(JSON.parse(await readFile(path.join(stackDir, NATIVE_PORTS_FILE), "utf8"))).toEqual(
      ports,
    );
    // The web port was taken, so the web URL moved, past the database and API ports, and was saved.
    expect(again.webUrl()).toBe("http://127.0.0.1:40002");
    expect(await readFile(path.join(stackDir, STACK_WEB_URL_FILE), "utf8")).toBe(again.webUrl());
    expect(second.runs.some((call) => call.binary.endsWith("initdb"))).toBe(false);
    await again.stop();
  });

  it("never gives the web the port just chosen for the API", async () => {
    const { deps, byName } = harness({ localWebUrl: "http://127.0.0.1:40001" });
    const controller = new NativeStackController(deps);
    await controller.start();
    expect(byName("apps/api/dist/index.js")[0]?.env.API_PORT).toBe("40001");
    expect(controller.webUrl()).toBe("http://127.0.0.1:40002");
    expect(await readFile(path.join(stackDir, STACK_WEB_URL_FILE), "utf8")).toBe(
      controller.webUrl(),
    );
    expect(byName("apps/api/dist/index.js")[0]?.env.WEB_ORIGIN).toBe(controller.webUrl());
    await controller.stop();
  });

  it("fails the start when a service cannot be spawned, and still stops", async () => {
    const base = harness({
      fetch: async () => new Response("", { status: 503 }),
      healthTimeoutMs: 1_000,
    });
    const controller = new NativeStackController({
      ...base.deps,
      spawn: (command, args, options) => {
        const child = base.deps.spawn!(command, args, options) as unknown as FakeChild;
        if (!args.some((arg) => arg.endsWith("apps/api/dist/index.js")))
          return child as unknown as ChildProcess;
        const failed = new FakeChild(undefined, args, options.env);
        failed.failToSpawn();
        return failed as unknown as ChildProcess;
      },
    });
    const state = await controller.start();
    expect(state.phase).toBe("failed");
    expect(state.output).toContain("spawn ENOENT");
    expect(state.output).toContain("api exited");
    expect(controller.hasProcesses()).toBe(false);
    await expect(controller.stop()).resolves.toMatchObject({ phase: "idle" });
  });

  it("restarts a crashed service with growing delays once the stack is up", async () => {
    const { deps, byName } = harness();
    const controller = new NativeStackController(deps);
    await controller.start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    byName("apps/worker/dist/index.js")[0]!.exit();
    await vi.advanceTimersByTimeAsync(999);
    expect(byName("apps/worker/dist/index.js")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(byName("apps/worker/dist/index.js")).toHaveLength(2);
    byName("apps/worker/dist/index.js")[1]!.exit();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(byName("apps/worker/dist/index.js")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(byName("apps/worker/dist/index.js")).toHaveLength(3);
    expect(controller.state().phase).toBe("ready");
    vi.useRealTimers();
    await controller.stop();
  });

  it("fails the start, not restarts, when a service dies before it is ready", async () => {
    const { deps, byName } = harness({
      fetch: async () => {
        byName("apps/api/dist/index.js")[0]?.exit();
        return new Response("", { status: 503 });
      },
    });
    const controller = new NativeStackController(deps);
    const state = await controller.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toBe(
      "Rakazo services did not start. Check the output below, then retry.",
    );
    expect(controller.hasProcesses()).toBe(false);
  });

  it("reports a failed or tampered download without starting anything", async () => {
    const { deps, children } = harness();
    const controller = new NativeStackController({
      ...deps,
      installers: {
        ...deps.installers,
        postgres: async () => {
          throw new DownloadError("postgres does not match its pinned checksum");
        },
      },
    });
    const state = await controller.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toBe(
      "Downloading Rakazo failed. Check the internet connection, then retry.",
    );
    expect(state.output).toContain("postgres does not match its pinned checksum");
    expect(children).toEqual([]);
  });

  it("imports a Docker stack once, into a new database, before migrating", async () => {
    const imported: number[] = [];
    const { deps, runs } = harness({
      importFromDocker: async (target) => {
        imported.push(target.port);
      },
    });
    const controller = new NativeStackController(deps);
    await controller.start();
    expect(imported).toEqual([40000]);
    const migrateIndex = runs.findIndex((call) => call.args[0]?.endsWith("migrate-database.js"));
    expect(migrateIndex).toBeGreaterThan(-1);
    await controller.stop();
    await controller.start();
    expect(imported).toEqual([40000]);
    await controller.stop();
  });

  it("reruns a move that was cut short before it finished", async () => {
    // A launch that quit mid-move left a cluster and some copied files, but no import marker.
    await mkdir(path.join(stackDir, "postgres"), { recursive: true });
    await writeFile(path.join(stackDir, "postgres", "PG_VERSION"), "16\n");
    await mkdir(path.join(stackDir, "data"), { recursive: true });
    await writeFile(path.join(stackDir, "data", "partial"), "");
    const imported: string[] = [];
    const { deps, runs } = harness({
      importFromDocker: async (target) => {
        imported.push(target.dataDir);
      },
    });
    const controller = new NativeStackController(deps);
    expect((await controller.start()).phase).toBe("ready");
    expect(runs.some((call) => call.binary.endsWith("initdb"))).toBe(true);
    expect(existsSync(path.join(stackDir, "data", "partial"))).toBe(false);
    expect(imported).toEqual([path.join(stackDir, "data")]);
    await controller.stop();

    const again = harness({
      importFromDocker: async (target) => {
        imported.push(target.dataDir);
      },
    });
    const next = new NativeStackController(again.deps);
    await next.start();
    expect(imported).toHaveLength(1);
    expect(again.runs.some((call) => call.binary.endsWith("initdb"))).toBe(false);
    await next.stop();
  });

  it("drops the half-imported database so a retry imports again", async () => {
    const { deps } = harness({
      importFromDocker: async () => {
        throw new Error("pg_restore exited with code 1");
      },
    });
    const controller = new NativeStackController(deps);
    const state = await controller.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toBe(
      "Could not move your data from Docker. Check the output below, then retry.",
    );
    expect(existsSync(path.join(stackDir, "postgres"))).toBe(false);
  });
});
