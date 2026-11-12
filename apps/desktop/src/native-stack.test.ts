import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  DATABASE_CONTAINER,
  NATIVE_PORTS_FILE,
  NativeStackController,
  POSTGRES_IMAGE,
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
  signalCode: string | null = null;
  readonly signals: string[] = [];
  constructor(
    readonly pid: number | undefined,
    readonly args: string[],
    readonly env: Record<string, string>,
  ) {
    super();
  }
  kill(signal = "SIGTERM") {
    this.signals.push(signal);
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

const CLI = "/usr/local/bin/container";

/** What the computer runtime holds between launches: the database VM and its image. */
function fakeRuntime() {
  return {
    image: false,
    database: null as { running: boolean; port: number; fresh: boolean } | null,
    listening: false,
  };
}

function harness(
  overrides: Partial<NativeStackDeps> = {},
  runtime: ReturnType<typeof fakeRuntime> = fakeRuntime(),
) {
  const children: FakeChild[] = [];
  const runs: {
    binary: string;
    args: string[];
    env: Record<string, string>;
    input?: string;
    listening: boolean;
  }[] = [];
  let nextPid = 1000;
  let nextPort = 40000;
  const spawn: SpawnProcess = (_command, args, options) => {
    const child = new FakeChild(nextPid++, args, options.env);
    children.push(child);
    if (args.join(" ") === `start --attach ${DATABASE_CONTAINER}`) {
      const database = runtime.database;
      if (database) database.running = true;
      child.once("exit", () => {
        if (database) database.running = false;
        runtime.listening = false;
      });
      setImmediate(() => {
        // A new volume is first initialized on a socket-only server that also reports ready.
        if (database?.fresh)
          child.stdout.write("LOG:  database system is ready to accept connections\n");
        setImmediate(() => {
          if (database) database.fresh = false;
          runtime.listening = true;
          child.stdout.write('LOG:  listening on IPv4 address "0.0.0.0", port 5432\n');
          child.stdout.write("LOG:  database system is ready to accept connections\n");
        });
      });
    }
    return child as unknown as ChildProcess;
  };
  const run: RunDocker = async (binary, args, options) => {
    runs.push({
      binary,
      args,
      env: options.env,
      input: options.input,
      listening: runtime.listening,
    });
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (binary !== CLI) return ok();
    const command = args.join(" ");
    if (command === `inspect ${DATABASE_CONTAINER}`) {
      const database = runtime.database;
      if (!database)
        return { code: 1, stdout: "", stderr: `Error: container not found: ${DATABASE_CONTAINER}` };
      return ok(
        JSON.stringify([
          {
            configuration: { publishedPorts: [{ containerPort: 5432, hostPort: database.port }] },
            status: { state: database.running ? "running" : "stopped" },
          },
        ]),
      );
    }
    if (command === `image inspect ${POSTGRES_IMAGE}`)
      return runtime.image ? ok() : { code: 1, stdout: "", stderr: "not found" };
    if (args[0] === "image" && args[1] === "pull" && args.at(-1) === POSTGRES_IMAGE)
      runtime.image = true;
    if (args[0] === "create") {
      const publish = args[args.indexOf("--publish") + 1] ?? "";
      runtime.database = { running: false, port: Number(publish.split(":")[1]), fresh: true };
    }
    if (args[0] === "rm") runtime.database = null;
    if (args[0] === "stop" && runtime.database) runtime.database.running = false;
    return ok();
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
      containerRuntime: async () => ({ cli: CLI, ours: false }),
    },
    ...overrides,
  };
  const byName = (entry: string) =>
    children.filter((child) => child.args.some((arg) => arg.endsWith(entry)));
  const commands = () =>
    runs.filter((call) => call.binary === CLI).map((call) => call.args.slice(0, 2).join(" "));
  return { deps, children, runs, byName, commands, runtime };
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
  it("offers the stop item from the moment start begins, before Postgres is up", async () => {
    const { deps } = harness({
      hostComputer: { url: "http://host.docker.internal:47000", token: "host-token" },
    });
    // What the menu sees each time a phase change rebuilds it.
    const seen: { phase: string; running: boolean }[] = [];
    const controller: NativeStackController = new NativeStackController({
      ...deps,
      onState: (state) =>
        seen.push({ phase: state.phase, running: controller.managedStackRunning() }),
    });
    await controller.start();
    expect(seen.find((entry) => entry.phase === "starting")).toEqual({
      phase: "starting",
      running: true,
    });
    await controller.stop();
    expect(controller.managedStackRunning()).toBe(false);
  });

  it("brings up the database, migrations and the three services on loopback", async () => {
    const { deps, runs, byName } = harness({
      hostComputer: { url: "http://host.docker.internal:47000", token: "host-token" },
    });
    const controller = new NativeStackController(deps);
    const state = await controller.start();
    expect(state.phase).toBe("ready");
    await expect(controller.matchesDesiredStack()).resolves.toBe(true);

    const pull = runs.find(
      (call) => call.args.at(-1) === POSTGRES_IMAGE && call.args[1] === "pull",
    );
    expect(pull?.args).toContain("linux/arm64");
    const create = runs.find((call) => call.args[0] === "create");
    expect(create?.args).toEqual(
      expect.arrayContaining([
        "--platform",
        "linux/arm64",
        "--network",
        DATABASE_CONTAINER,
        `${DATABASE_CONTAINER}:/var/lib/postgresql/data`,
        "PGDATA=/var/lib/postgresql/data/pgdata",
        "POSTGRES_USER=rakazo",
        "127.0.0.1:40000:5432",
      ]),
    );
    // The password reaches the VM through the CLI's environment, never its arguments.
    expect(create?.args.some((arg) => arg.includes("cdcd"))).toBe(false);
    expect(create?.env.POSTGRES_PASSWORD).toBe("cd".repeat(16));
    expect(byName(DATABASE_CONTAINER)[0]?.args).toEqual(["start", "--attach", DATABASE_CONTAINER]);
    const migrate = runs.find((call) => call.args[0]?.endsWith("migrate-database.js"));
    // Migrations wait for the real server, not the one that initializes a new volume.
    expect(migrate?.listening).toBe(true);
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
      LOCAL_VM_CLI: CLI,
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

    // Running services keep the menu's off-switch available after a server switch.
    expect(controller.managedStackRunning()).toBe(true);
    await controller.stop();
    expect(controller.hasProcesses()).toBe(false);
    expect(controller.managedStackRunning()).toBe(false);
    // The runtime CLI passes SIGINT on, so Postgres shuts down fast and cleanly.
    expect(byName(DATABASE_CONTAINER)[0]?.signals).toEqual(["SIGINT"]);
  });

  it("keeps its database and ports across restarts while they stay free", async () => {
    const first = harness();
    const controller = new NativeStackController(first.deps);
    await controller.start();
    await controller.stop();
    expect(first.runtime.database?.running).toBe(false);
    const ports = JSON.parse(await readFile(path.join(stackDir, NATIVE_PORTS_FILE), "utf8"));
    expect(ports).toEqual({ postgres: 40000, api: 40001, database: "theirs" });

    const second = harness({ portFree: async (port) => port !== 5173 }, first.runtime);
    const again = new NativeStackController(second.deps);
    await again.start();
    expect(JSON.parse(await readFile(path.join(stackDir, NATIVE_PORTS_FILE), "utf8"))).toEqual(
      ports,
    );
    // The web port was taken, so the web URL moved, past the database and API ports, and was saved.
    expect(again.webUrl()).toBe("http://127.0.0.1:40002");
    expect(await readFile(path.join(stackDir, STACK_WEB_URL_FILE), "utf8")).toBe(again.webUrl());
    expect(second.commands()).not.toContain("create --name");
    expect(
      second.runs.some((call) => call.args[1] === "pull" && call.args.at(-1) === POSTGRES_IMAGE),
    ).toBe(false);
    await again.stop();
  });

  it("keeps the running runtime copy when it reports its path resolved", async () => {
    const runtimeDir = path.join(stackDir, "runtime");
    await mkdir(path.join(runtimeDir, "container-1.6.0", "bin"), { recursive: true });
    await mkdir(path.join(runtimeDir, "server-0.9.0"), { recursive: true });
    // macOS reports `/private/var/…` for a stack under `/var/…`.
    const cli = path.join(await realpath(runtimeDir), "container-1.6.0", "bin", "container");
    const { deps } = harness();
    const controller = new NativeStackController({
      ...deps,
      installers: { ...deps.installers, containerRuntime: async () => ({ cli, ours: true }) },
    });
    expect((await controller.start()).phase).toBe("ready");
    expect(existsSync(path.join(runtimeDir, "container-1.6.0"))).toBe(true);
    expect(existsSync(path.join(runtimeDir, "server-0.9.0"))).toBe(false);
    await controller.stop();
  });

  it("stops a database VM a crashed launch left running before attaching to it", async () => {
    const runtime = fakeRuntime();
    runtime.image = true;
    runtime.database = { running: true, port: 41000, fresh: false };
    const { deps, commands } = harness({}, runtime);
    const controller = new NativeStackController(deps);
    expect((await controller.start()).phase).toBe("ready");
    expect(commands()).toContain("stop --time");
    expect(commands()).not.toContain("create --name");
    expect(
      JSON.parse(await readFile(path.join(stackDir, NATIVE_PORTS_FILE), "utf8")).postgres,
    ).toBe(41000);
    await controller.stop();
  });

  it("recreates the database VM on a new port when its port is taken, keeping the volume", async () => {
    const runtime = fakeRuntime();
    runtime.image = true;
    runtime.database = { running: false, port: 41000, fresh: false };
    const { deps, runs, commands } = harness({ portFree: async (port) => port !== 41000 }, runtime);
    const controller = new NativeStackController(deps);
    expect((await controller.start()).phase).toBe("ready");
    expect(commands().filter((command) => /^(rm|create|volume)/.test(command))).toEqual([
      `rm ${DATABASE_CONTAINER}`,
      "volume create",
      "create --name",
    ]);
    expect(runs.find((call) => call.args[0] === "create")?.args).toContain("127.0.0.1:40000:5432");
    expect(
      runs.find((call) => call.args[0]?.endsWith("migrate-database.js"))?.env.DATABASE_URL,
    ).toMatch(/@127\.0\.0\.1:40000\//);
    await controller.stop();
  });

  it("restarts the database VM like any service when it stops on its own", async () => {
    const { deps, byName } = harness();
    const controller = new NativeStackController(deps);
    await controller.start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    byName(DATABASE_CONTAINER)[0]!.exit();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(byName(DATABASE_CONTAINER)).toHaveLength(2);
    expect(controller.state().phase).toBe("ready");
    vi.useRealTimers();
    await controller.stop();
  });

  it.each([
    ["before", "create"],
    ["after", "start"],
  ])("records the database's runtime before creating it (cut short %s create)", async (_, step) => {
    const first = harness();
    const cutShort = new NativeStackController({
      ...first.deps,
      run: async (binary, args, options) =>
        args[0] === step && args[1] !== "--attach"
          ? { code: 1, stdout: "", stderr: "interrupted" }
          : first.deps.run(binary, args, options),
      spawn: (command, args, options) => {
        if (step === "start") throw new Error("launch cut short");
        return first.deps.spawn!(command, args, options);
      },
    });
    expect((await cutShort.start()).phase).toBe("failed");
    expect(
      JSON.parse(await readFile(path.join(stackDir, NATIVE_PORTS_FILE), "utf8")).database,
    ).toBe("theirs");

    // The next launch finds a different runtime, which has no database: it must not make one.
    const other = harness({}, fakeRuntime());
    const controller = new NativeStackController({
      ...other.deps,
      installers: {
        ...other.deps.installers,
        containerRuntime: async () => ({ cli: CLI, ours: true }),
      },
    });
    const state = await controller.start();
    expect(state.message).toBe(
      "Your Rakazo data is in a different computer runtime. Quit the one running, then retry.",
    );
    expect(other.commands().filter((command) => /create/.test(command))).toEqual([]);

    // Back on the runtime that holds it, the start finishes what was cut short.
    const again = harness({}, first.runtime);
    const resumed = new NativeStackController(again.deps);
    expect((await resumed.start()).phase).toBe("ready");
    await resumed.stop();
  });

  it("refuses to start an empty database when its data is in the other runtime", async () => {
    await mkdir(stackDir, { recursive: true });
    await writeFile(
      path.join(stackDir, NATIVE_PORTS_FILE),
      JSON.stringify({ postgres: 41000, database: "ours" }),
    );
    const resolved: (boolean | undefined)[] = [];
    const { deps, commands } = harness();
    const controller = new NativeStackController({
      ...deps,
      installers: {
        ...deps.installers,
        containerRuntime: async (input) => {
          resolved.push(input.keepOurs);
          return { cli: CLI, ours: false };
        },
      },
    });
    const state = await controller.start();
    expect(resolved).toEqual([true]);
    expect(state.phase).toBe("failed");
    expect(state.message).toBe(
      "Your Rakazo data is in a different computer runtime. Quit the one running, then retry.",
    );
    expect(commands()).not.toContain("create --name");
  });

  it("keeps the database owner apart from the runtime login, whatever the .env names", async () => {
    await mkdir(stackDir, { recursive: true });
    await writeFile(
      path.join(stackDir, ".env"),
      `${TEMPLATE.replace("POSTGRES_USER=rakazo", "POSTGRES_USER=rakazo_app")}DATABASE_MIGRATION_URL=postgres://owner:secret@db/rakazo\n`,
    );
    const targets: string[] = [];
    const { deps, runs, byName } = harness({
      importFromDocker: async (target) => {
        targets.push(target.user);
      },
    });
    const controller = new NativeStackController(deps);
    expect((await controller.start()).phase).toBe("ready");
    expect(runs.find((call) => call.args[0] === "create")?.args).toContain("POSTGRES_USER=rakazo");
    expect(targets).toEqual(["rakazo"]);
    const migrate = runs.find((call) => call.args[0]?.endsWith("migrate-database.js"));
    expect(migrate?.env.DATABASE_MIGRATION_URL).toMatch(/^postgres:\/\/rakazo:/);
    for (const name of ["apps/api/dist/index.js", "apps/worker/dist/index.js"]) {
      expect(byName(name)[0]?.env.DATABASE_MIGRATION_URL).toBeUndefined();
    }
    await controller.stop();
  });

  it("cancels the other downloads when one fails, and waits for them", async () => {
    const order: string[] = [];
    const waitForAbort = (name: string) => (deps: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) =>
        deps.signal.addEventListener("abort", () =>
          setImmediate(() => {
            order.push(`${name} stopped`);
            reject(new Error("aborted"));
          }),
        ),
      );
    const { deps } = harness();
    const controller = new NativeStackController({
      ...deps,
      installers: {
        server: async () => {
          throw new DownloadError("the server bundle does not match its pinned checksum");
        },
        containerRuntime: waitForAbort("runtime"),
      },
    });
    const state = await controller.start();
    order.push("start failed");
    expect(state.message).toBe(
      "Downloading Rakazo failed. Check the internet connection, then retry.",
    );
    expect(order).toEqual(["runtime stopped", "start failed"]);
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
      run: async (binary, args, options) =>
        args[1] === "pull" && args.at(-1) === POSTGRES_IMAGE
          ? { code: 1, stdout: "", stderr: "" }
          : deps.run(binary, args, options),
    });
    const state = await controller.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toBe(
      "Downloading Rakazo failed. Check the internet connection, then retry.",
    );
    expect(state.output).toContain("Pulling the database image exited with code 1");
    expect(children).toEqual([]);
  });

  it("imports a Docker stack once, into an emptied database, before migrating", async () => {
    const order: string[] = [];
    const { deps, runs } = harness({
      importFromDocker: async (target) => {
        order.push(`import ${target.cli} ${target.container} ${target.user} ${target.database}`);
      },
    });
    const controller = new NativeStackController({
      ...deps,
      run: async (binary, args, options) => {
        if (args.includes("psql")) order.push(`psql ${options.input?.trim()}`);
        if (args[0]?.endsWith("migrate-database.js")) order.push("migrate");
        return deps.run(binary, args, options);
      },
    });
    expect((await controller.start()).phase).toBe("ready");
    expect(order).toEqual([
      "psql DROP DATABASE IF EXISTS rakazo WITH (FORCE);\nCREATE DATABASE rakazo;",
      `import ${CLI} ${DATABASE_CONTAINER} rakazo rakazo`,
      "migrate",
    ]);
    expect(runs.find((call) => call.args.includes("psql"))?.args).not.toContain("-h");
    await controller.stop();
    await controller.start();
    expect(order.filter((entry) => entry.startsWith("import"))).toHaveLength(1);
    await controller.stop();
  });

  it("reruns a move that was cut short, or failed, until it completes", async () => {
    // A launch that quit mid-move left copied files, but no import marker.
    await mkdir(path.join(stackDir, "data"), { recursive: true });
    await writeFile(path.join(stackDir, "data", "partial"), "");
    const runtime = fakeRuntime();
    let fail = true;
    const imported: string[] = [];
    const importFromDocker = async (target: { dataDir: string }) => {
      expect(existsSync(path.join(target.dataDir, "partial"))).toBe(false);
      imported.push(target.dataDir);
      if (fail) throw new Error("pg_restore exited with code 1");
    };
    const first = new NativeStackController(harness({ importFromDocker }, runtime).deps);
    const failed = await first.start();
    expect(failed.phase).toBe("failed");
    expect(failed.message).toBe(
      "Could not move your data from Docker. Check the output below, then retry.",
    );
    expect(first.hasProcesses()).toBe(false);

    fail = false;
    const retry = harness({ importFromDocker }, runtime);
    const second = new NativeStackController(retry.deps);
    expect((await second.start()).phase).toBe("ready");
    expect(retry.runs.some((call) => call.input?.includes("DROP DATABASE"))).toBe(true);
    await second.stop();

    const third = new NativeStackController(harness({ importFromDocker }, runtime).deps);
    await third.start();
    expect(imported).toHaveLength(2);
    await third.stop();
  });
});
