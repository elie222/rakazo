import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunDocker, RunDockerResult } from "./docker-cli.js";
import {
  COMPOSE_WAIT_TIMEOUT_S,
  ensureStackEnv,
  ensureStackToken,
  initialStackState,
  LocalStackController,
  type LocalStackDeps,
  readStackToken,
  reduceStackState,
  renderStackEnv,
  resolveImageTag,
  STACK_COMPOSE_FILE,
  STACK_ENV_FILE,
  STACK_ENV_TEMPLATE,
  STACK_OUTPUT_LINES,
  STACK_TOKEN_FILE,
  stackDir,
  stackFailureMessage,
  stackResourceDir,
} from "./local-stack.js";

const COMPOSE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "infra", "compose");
const fakeHex = (bytes: number) => "ab".repeat(bytes);

describe("stack locations", () => {
  it("keeps the compose project under user data", () => {
    expect(stackDir("/data/rakazo")).toBe(path.join("/data/rakazo", "stack"));
  });

  it("reads resources from the bundle when packaged and from the repo otherwise", () => {
    expect(
      stackResourceDir({ packaged: true, resourcesPath: "/App/Resources", appPath: "/x" }),
    ).toBe(path.join("/App/Resources", "stack"));
    expect(
      stackResourceDir({ packaged: false, resourcesPath: "/x", appPath: "/repo/apps/desktop" }),
    ).toBe(path.resolve("/repo/infra/compose"));
  });
});

describe("resolveImageTag", () => {
  it("pins installed builds to their own version", () => {
    expect(resolveImageTag({ version: "0.2.0", packaged: true })).toBe("v0.2.0");
  });

  it("follows edge for development builds and prereleases", () => {
    expect(resolveImageTag({ version: "0.2.0", packaged: false })).toBe("edge");
    expect(resolveImageTag({ version: "0.2.0-beta.1", packaged: true })).toBe("edge");
  });

  it("lets RAKAZO_IMAGE_TAG override everything", () => {
    expect(resolveImageTag({ version: "0.2.0", packaged: true, override: " v9.9.9 " })).toBe(
      "v9.9.9",
    );
    expect(resolveImageTag({ version: "0.2.0", packaged: true, override: "" })).toBe("v0.2.0");
  });
});

describe("renderStackEnv", () => {
  it("fills the five secrets and drops the image tag lines of the shipped template", async () => {
    const template = await readFile(path.join(COMPOSE_DIR, STACK_ENV_TEMPLATE), "utf8");
    const rendered = renderStackEnv(template, fakeHex);
    const lines = rendered.split("\n");

    expect(lines).toContain(`POSTGRES_PASSWORD=${"ab".repeat(16)}`);
    for (const name of [
      "BETTER_AUTH_SECRET",
      "ENCRYPTION_KEY",
      "SCREEN_PROXY_SECRET",
      "SANDBOX_SUPERVISOR_TOKEN",
    ]) {
      expect(lines).toContain(`${name}=${"ab".repeat(32)}`);
    }
    expect(lines.some((line) => line.startsWith("RAKAZO_IMAGE_TAG="))).toBe(false);
    expect(lines.some((line) => line.startsWith("RAKAZO_COMPUTER_IMAGE_TAG="))).toBe(false);
    // Everything else, including the image names and empty optional keys, stays verbatim.
    expect(lines).toContain("RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app");
    expect(lines).toContain("SANDBOX_PROVIDER=docker");
    expect(lines).toContain("OPENROUTER_API_KEY=");
    expect(rendered.endsWith("\n")).toBe(template.endsWith("\n"));
  });

  it("leaves a secret that already has a value alone", () => {
    expect(renderStackEnv("POSTGRES_PASSWORD=keep\n# note=\n", fakeHex)).toBe(
      "POSTGRES_PASSWORD=keep\n# note=\n",
    );
  });
});

describe("ensureStackEnv", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rakazo-stack-env-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a private .env from the template", async () => {
    await expect(ensureStackEnv(dir, "POSTGRES_PASSWORD=\n", fakeHex)).resolves.toBe("created");
    const file = path.join(dir, STACK_ENV_FILE);
    await expect(readFile(file, "utf8")).resolves.toBe(`POSTGRES_PASSWORD=${"ab".repeat(16)}\n`);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("never touches an existing .env", async () => {
    await writeFile(path.join(dir, STACK_ENV_FILE), "sentinel\n", "utf8");
    await expect(ensureStackEnv(dir, "POSTGRES_PASSWORD=\n", fakeHex)).resolves.toBe("kept");
    await expect(readFile(path.join(dir, STACK_ENV_FILE), "utf8")).resolves.toBe("sentinel\n");
  });
});

describe("stack identity", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rakazo-stack-token-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates one private token and reuses it", async () => {
    const token = await ensureStackToken(dir, fakeHex);
    await expect(ensureStackToken(dir, () => "cd".repeat(32))).resolves.toBe(token);
    await expect(readStackToken(dir)).resolves.toBe(token);
    if (process.platform !== "win32") {
      expect((await stat(path.join(dir, STACK_TOKEN_FILE))).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces an invalid legacy token", async () => {
    await writeFile(path.join(dir, STACK_TOKEN_FILE), "not-a-token\n", "utf8");
    await expect(ensureStackToken(dir, fakeHex)).resolves.toBe("ab".repeat(32));
  });
});

describe("reduceStackState", () => {
  const start = initialStackState("edge");

  it("walks the happy path and only records output while docker is working", () => {
    let state = reduceStackState(start, { type: "check-start" });
    expect(state.phase).toBe("checking-docker");
    state = reduceStackState(state, { type: "output", line: "ignored" });
    expect(state.output).toEqual([]);
    state = reduceStackState(state, { type: "prepare" });
    state = reduceStackState(state, { type: "pull-start" });
    state = reduceStackState(state, { type: "output", line: "app Pulled" });
    state = reduceStackState(state, { type: "up-start" });
    state = reduceStackState(state, { type: "output", line: "web Started" });
    state = reduceStackState(state, { type: "wait-start" });
    expect(state).toMatchObject({
      phase: "waiting-healthy",
      message: null,
      output: ["app Pulled", "web Started"],
      imageTag: "edge",
    });
    state = reduceStackState(state, { type: "ready" });
    expect(state.phase).toBe("ready");
  });

  it("keeps only the last lines of output", () => {
    let state = reduceStackState(start, { type: "check-start" });
    state = reduceStackState(state, { type: "pull-start" });
    for (let index = 0; index < STACK_OUTPUT_LINES + 5; index += 1) {
      state = reduceStackState(state, { type: "output", line: `line ${index}` });
    }
    expect(state.output).toHaveLength(STACK_OUTPUT_LINES);
    expect(state.output[0]).toBe("line 5");
  });

  it("holds terminal phases until the next check-start clears them", () => {
    let state = reduceStackState(start, { type: "check-start" });
    state = reduceStackState(state, { type: "pull-start" });
    state = reduceStackState(state, { type: "output", line: "manifest unknown" });
    state = reduceStackState(state, { type: "failed", message: "Pull failed." });
    expect(state).toMatchObject({ phase: "failed", message: "Pull failed." });
    expect(reduceStackState(state, { type: "ready" })).toBe(state);
    expect(reduceStackState(state, { type: "output", line: "late" })).toBe(state);

    state = reduceStackState(state, { type: "check-start" });
    expect(state).toMatchObject({ phase: "checking-docker", message: null, output: [] });
  });

  it("records why Docker is unavailable", () => {
    const state = reduceStackState(reduceStackState(start, { type: "check-start" }), {
      type: "docker-missing",
      message: "Docker is not installed on this computer.",
    });
    expect(state).toMatchObject({
      phase: "docker-missing",
      message: "Docker is not installed on this computer.",
    });
  });
});

describe("stackFailureMessage", () => {
  it("names the tag when images are not published yet", () => {
    expect(stackFailureMessage("image-not-found", "pulling", "v0.2.0")).toBe(
      "Images for v0.2.0 are not published yet. Try again in a few minutes.",
    );
  });

  it("points at the ports for a port clash", () => {
    expect(stackFailureMessage("port-in-use", "starting", "edge")).toContain("5173 or 3100");
  });

  it("explains the docker group for socket permission errors", () => {
    expect(stackFailureMessage("socket-permission", "pulling", "edge")).toContain("docker group");
  });

  it("falls back to phase-specific wording", () => {
    expect(stackFailureMessage("other", "pulling", "edge")).toContain("Downloading");
    expect(stackFailureMessage("other", "starting", "edge")).toContain("did not start");
  });
});

interface RecordedCall {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

type Script = (
  args: string[],
) => Partial<RunDockerResult> & { lines?: string[]; wait?: Promise<void> };

function fakeRun(calls: RecordedCall[], script: Script): RunDocker {
  return async (binary, args, options) => {
    calls.push({ binary, args, cwd: options.cwd, env: options.env });
    const { lines = [], wait, ...reply } = script(args);
    for (const line of lines) options.onLine?.(line);
    await wait;
    return { code: 0, stdout: "", stderr: "", ...reply };
  };
}

const ok: Script = (args) => {
  if (args[0] === "compose" && args[1] === "version") return { stdout: "2.29.0\n" };
  if (args[0] === "info") return { stdout: "27.1.1\n" };
  const subcommand = args[5];
  if (subcommand === "pull") return { lines: ["app Pulled", "computer Pulled"] };
  if (subcommand === "up") return { lines: ["Container rakazo-web-1 Started"] };
  return {};
};

describe("LocalStackController", () => {
  let root: string;
  let calls: RecordedCall[];
  let phases: string[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "rakazo-stack-"));
    calls = [];
    phases = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function controller(overrides: Partial<LocalStackDeps> = {}, script: Script = ok) {
    const run = fakeRun(calls, script);
    const probe = overrides.probe ?? (async () => "v1.2.3");
    const deps: LocalStackDeps = {
      platform: "linux",
      env: { PATH: "/usr/bin", HOME: "/home/me", OPENROUTER_API_KEY: "sk-secret" },
      exists: (file) => file === "/usr/bin/docker",
      stackDir: path.join(root, "stack"),
      resourceDir: COMPOSE_DIR,
      localWebUrl: "http://127.0.0.1:5173",
      imageTag: "v1.2.3",
      randomHex: fakeHex,
      sleep: async () => undefined,
      healthTimeoutMs: 50,
      ...overrides,
      // Record the phase a poller would see while each docker command and probe runs.
      run: (binary, args, options) => {
        phases.push(stack.state().phase);
        return run(binary, args, options);
      },
      probe: (url, signal, token) => {
        phases.push(stack.state().phase);
        return probe(url, signal, token);
      },
    };
    const stack = new LocalStackController(deps);
    return stack;
  }

  it("installs the compose project and walks every phase to ready", async () => {
    const stack = controller();
    expect(stack.state()).toEqual(initialStackState("v1.2.3"));

    const state = await stack.start();
    expect(state).toMatchObject({ phase: "ready", message: null, imageTag: "v1.2.3" });
    expect(state.output).toEqual([
      "app Pulled",
      "computer Pulled",
      "Container rakazo-web-1 Started",
    ]);
    expect(phases).toEqual([
      "checking-docker",
      "checking-docker",
      "pulling",
      "starting",
      "waiting-healthy",
    ]);

    const stackPath = path.join(root, "stack");
    const compose = ["compose", "--env-file", ".env", "-f", STACK_COMPOSE_FILE];
    expect(calls.map((call) => call.args)).toEqual([
      ["compose", "version", "--short"],
      ["info", "--format", "{{.ServerVersion}}"],
      [...compose, "pull"],
      [...compose, "up", "-d", "--wait", "--wait-timeout", String(COMPOSE_WAIT_TIMEOUT_S)],
    ]);
    for (const call of calls) {
      expect(call.binary).toBe("/usr/bin/docker");
      expect(call.cwd).toBe(stackPath);
      expect(call.env).toMatchObject({
        RAKAZO_IMAGE_TAG: "v1.2.3",
        RAKAZO_COMPUTER_IMAGE_TAG: "v1.2.3",
        COMPOSE_PROGRESS: "plain",
        HOME: "/home/me",
      });
      expect(call.env).not.toHaveProperty("OPENROUTER_API_KEY");
    }
    expect(calls.at(-1)?.env.RAKAZO_DESKTOP_STACK_TOKEN).toBe("ab".repeat(32));

    await expect(readFile(path.join(stackPath, STACK_COMPOSE_FILE), "utf8")).resolves.toBe(
      await readFile(path.join(COMPOSE_DIR, STACK_COMPOSE_FILE), "utf8"),
    );
    const env = await readFile(path.join(stackPath, STACK_ENV_FILE), "utf8");
    expect(env).toContain(`POSTGRES_PASSWORD=${"ab".repeat(16)}`);
    expect(env).not.toContain("RAKAZO_IMAGE_TAG=");
    if (process.platform !== "win32") {
      expect((await stat(path.join(stackPath, STACK_ENV_FILE))).mode & 0o777).toBe(0o600);
      expect((await stat(stackPath)).mode & 0o777).toBe(0o700);
    }
  });

  it("reuses only the privately identified stack on the desired image", async () => {
    const stackPath = path.join(root, "stack");
    await mkdir(stackPath, { recursive: true });
    const token = await ensureStackToken(stackPath, fakeHex);
    const probedUrls: string[] = [];
    const stack = controller({
      probe: async (url, _signal, supplied) => {
        probedUrls.push(url);
        return supplied === token ? "v1.2.3" : null;
      },
    });

    await expect(stack.matchesDesiredStack()).resolves.toBe(true);
    expect(probedUrls).toEqual(["http://127.0.0.1:5173"]);
    await expect(stack.matchesDesiredStack("http://127.0.0.1:5199")).resolves.toBe(true);
    expect(probedUrls).toEqual(["http://127.0.0.1:5173", "http://127.0.0.1:5199"]);
    expect(calls).toEqual([]);
  });

  it("rejects another listener and a managed stack from an older release", async () => {
    const stackPath = path.join(root, "stack");
    await mkdir(stackPath, { recursive: true });
    await ensureStackToken(stackPath, fakeHex);

    await expect(controller({ probe: async () => null }).matchesDesiredStack()).resolves.toBe(
      false,
    );
    await expect(controller({ probe: async () => "v1.2.2" }).matchesDesiredStack()).resolves.toBe(
      false,
    );
  });

  it("uses a plain up -d for Compose plugins older than 2.17", async () => {
    const stack = controller({}, (args) =>
      args[1] === "version" ? { stdout: "2.12.2\n" } : ok(args),
    );
    await stack.start();
    expect(calls.at(-1)?.args.slice(5)).toEqual(["up", "-d"]);
  });

  it("stops at docker-missing when no binary exists and touches nothing", async () => {
    const stack = controller({ exists: () => false });
    const state = await stack.start();
    expect(state).toMatchObject({
      phase: "docker-missing",
      message: "Docker is not installed on this computer.",
    });
    expect(calls).toEqual([]);
    await expect(stat(path.join(root, "stack", STACK_ENV_FILE))).rejects.toThrow();
  });

  it("reports a missing Compose plugin as docker-missing", async () => {
    const stack = controller({}, (args) =>
      args[1] === "version"
        ? { code: 1, stderr: "docker: 'compose' is not a docker command" }
        : ok(args),
    );
    const state = await stack.start();
    expect(state.phase).toBe("docker-missing");
    expect(state.message).toContain("Docker Compose is missing");
    expect(calls).toHaveLength(1);
  });

  it("waits for the daemon when docker info fails", async () => {
    const stack = controller({}, (args) =>
      args[0] === "info"
        ? { code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" }
        : ok(args),
    );
    const state = await stack.start();
    expect(state).toMatchObject({
      phase: "docker-not-running",
      message: "Docker is installed but not running. Start Docker, then check again.",
    });
    expect(calls).toHaveLength(2);
  });

  it("explains the docker group when the socket is not accessible", async () => {
    const stack = controller({}, (args) =>
      args[0] === "info"
        ? { code: 1, stderr: "permission denied while trying to connect to the Docker daemon" }
        : ok(args),
    );
    const state = await stack.start();
    expect(state.phase).toBe("docker-not-running");
    expect(state.message).toContain("docker group");
  });

  it("fails with a tag-specific message when the images are not published", async () => {
    const stack = controller({}, (args) =>
      args[5] === "pull"
        ? {
            code: 1,
            stderr: "Error response from daemon: manifest unknown",
            lines: ["Error response from daemon: manifest unknown"],
          }
        : ok(args),
    );
    const state = await stack.start();
    expect(state).toMatchObject({
      phase: "failed",
      message: "Images for v1.2.3 are not published yet. Try again in a few minutes.",
      output: ["Error response from daemon: manifest unknown"],
    });
    expect(calls.map((call) => call.args[5] ?? call.args[0])).toEqual(["compose", "info", "pull"]);
  });

  it("reports interruption instead of a pull failure when docker returns 130", async () => {
    const stack = controller({}, (args) =>
      args[5] === "pull" ? { code: 130, stderr: "got 3 SIGTERM" } : ok(args),
    );
    const state = await stack.start();
    expect(state).toMatchObject({
      phase: "failed",
      message: "The start was interrupted. Retry to continue.",
    });
  });

  it("collects service logs when up fails", async () => {
    const stack = controller({}, (args) => {
      if (args[5] === "up") {
        return { code: 1, stderr: "port is already allocated", lines: ["web Error"] };
      }
      if (args[5] === "logs") return { lines: ["web-1 | EADDRINUSE"] };
      return ok(args);
    });
    const state = await stack.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("5173 or 3100");
    expect(state.output).toEqual([
      "app Pulled",
      "computer Pulled",
      "web Error",
      "web-1 | EADDRINUSE",
    ]);
    expect(calls.at(-1)?.args.slice(5)).toEqual(["logs", "--tail", "30", "--no-color"]);
  });

  it("fails when the web app never answers after up", async () => {
    let probes = 0;
    const stack = controller({
      probe: async () => {
        probes += 1;
        return null;
      },
    });
    const state = await stack.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("did not answer");
    expect(probes).toBeGreaterThan(1);
  });

  it("returns the same attempt while one is in flight and restarts after failure", async () => {
    let attempts = 0;
    const stack = controller({}, (args) => {
      if (args[5] === "pull") {
        attempts += 1;
        return attempts === 1 ? { code: 1, stderr: "no such host" } : ok(args);
      }
      return ok(args);
    });
    const first = stack.start();
    expect(stack.start()).toBe(first);
    const failed = await first;
    expect(failed).toMatchObject({ phase: "failed" });
    expect(failed.message).toContain("registry");

    const second = await stack.start();
    expect(second.phase).toBe("ready");
    expect(attempts).toBe(2);
  });

  it("does not leak randomness or docker output into the message", async () => {
    const stack = controller({}, (args) =>
      args[5] === "pull" ? { code: 1, stderr: "/Users/me/secret-path: boom" } : ok(args),
    );
    const state = await stack.start();
    expect(state.message).not.toContain("/Users/me");
  });

  it("stops the containers with compose stop and returns to idle", async () => {
    const stack = controller();
    await stack.start();
    const state = await stack.stop();
    expect(state).toEqual(initialStackState("v1.2.3"));
    expect(calls.at(-1)?.args.slice(5)).toEqual(["stop"]);
  });

  it("reports a stop when docker has gone missing since the start", async () => {
    let installed = true;
    const stack = controller({ exists: (file) => installed && file === "/usr/bin/docker" });
    await stack.start();
    installed = false;
    const state = await stack.stop();
    expect(state).toMatchObject({
      phase: "failed",
      message: expect.stringContaining("Could not stop"),
    });
    expect(calls.at(-1)?.args.slice(5)).not.toEqual(["stop"]);
  });

  it("reports a stop that docker refused instead of pretending the stack is down", async () => {
    const stack = controller({}, (args) =>
      args[5] === "stop"
        ? { code: 1, stderr: "/Users/me/secret-path: Cannot connect to the Docker daemon" }
        : ok(args),
    );
    await stack.start();
    expect(stack.state().phase).toBe("ready");
    const state = await stack.stop();
    expect(state).toMatchObject({
      phase: "failed",
      message: "Could not stop the local stack. Check that Docker is running, then try again.",
      imageTag: "v1.2.3",
    });
    expect(state.message).not.toContain("/Users/me");
    expect(state).not.toEqual(initialStackState("v1.2.3"));
    expect(calls.at(-1)?.args.slice(5)).toEqual(["stop"]);
  });

  it("queues a start behind a stop so up and stop never overlap", async () => {
    let releaseStop: () => void = () => undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stack = controller({}, (args) => {
      if (args[5] === "stop") return { wait: stopGate };
      return ok(args);
    });
    await stack.start();
    const stopping = stack.stop();
    const restarted = stack.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.at(-1)?.args.slice(5)).toEqual(["stop"]);
    releaseStop();
    await stopping;
    expect((await restarted).phase).toBe("ready");
    const order = calls.map((call) => call.args[5] ?? call.args[0]);
    expect(order.indexOf("stop")).toBeLessThan(order.lastIndexOf("compose"));
  });

  it("queues a fresh start behind a stop instead of joining the aborted attempt", async () => {
    let releaseStop: () => void = () => undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let probes = 0;
    let markProbeStarted: () => void = () => undefined;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const stack = controller(
      {
        probe: (_url, signal) => {
          probes += 1;
          if (probes > 1) return Promise.resolve("v1.2.3");
          markProbeStarted();
          if (signal.aborted) return Promise.resolve(null);
          return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)));
        },
      },
      (args) => (args[5] === "stop" ? { wait: stopGate } : ok(args)),
    );
    const first = stack.start();
    await probeStarted;
    const stopping = stack.stop();
    const second = stack.start();
    expect(second).not.toBe(first);
    expect(stack.start()).toBe(second);
    releaseStop();
    await stopping;
    expect((await first).message).toBe("The start was interrupted. Retry to continue.");
    expect((await second).phase).toBe("ready");
    const order = calls.map((call) => call.args[5] ?? call.args[0]);
    expect(order.indexOf("stop")).toBeLessThan(order.lastIndexOf("up"));
  });

  it("honours a second stop over a start queued behind a slow first stop", async () => {
    let releaseStop: () => void = () => undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stops = 0;
    const stack = controller({}, (args) => {
      if (args[5] !== "stop") return ok(args);
      stops += 1;
      return stops === 1 ? { wait: stopGate } : {};
    });
    await stack.start();
    const firstStop = stack.stop();
    const queuedStart = stack.start();
    const secondStop = stack.stop();
    expect(secondStop).not.toBe(firstStop);
    releaseStop();
    await Promise.all([firstStop, queuedStart, secondStop]);
    expect(stack.state()).toEqual(initialStackState("v1.2.3"));
    const order = calls.map((call) => call.args[5] ?? call.args[0]);
    expect(order.lastIndexOf("up")).toBeLessThan(order.indexOf("stop"));
  });

  it("does not wait out a slow health probe when stopped", async () => {
    const stack = controller({
      probe: (_url, signal) =>
        signal.aborted
          ? Promise.resolve(null)
          : new Promise((resolve) => signal.addEventListener("abort", () => resolve(null))),
    });
    const started = stack.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopped = await stack.stop();
    expect(stopped).toEqual(initialStackState("v1.2.3"));
    expect((await started).message).toBe("The start was interrupted. Retry to continue.");
  });

  it("surfaces a broken resource bundle instead of hanging", async () => {
    const resourceDir = path.join(root, "empty");
    await mkdir(resourceDir);
    const stack = controller({ resourceDir });
    const state = await stack.start();
    expect(state).toMatchObject({
      phase: "failed",
      message: "Could not prepare the local stack. Retry.",
    });
    // copyFile/readFile ENOENT must not leak absolute paths into user-facing state.
    expect(state.message).not.toContain(resourceDir);
    expect(state.message).not.toContain(root);
  });
});
