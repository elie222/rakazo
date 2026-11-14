// Moving an existing Docker This computer stack to the stack that runs without Docker. Asked once;
// the Docker stack is only stopped, never removed, so nothing is lost if the move fails.
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RunDocker } from "./docker-cli.js";
import { dockerSpawnEnv, resolveDockerBinary } from "./docker-cli.js";
import { STACK_COMPOSE_FILE, STACK_ENV_FILE, STACK_PROJECT_NAME } from "./local-stack.js";
import type { DockerImportTarget } from "./native-stack.js";
import { NATIVE_PORTS_FILE } from "./native-stack.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const STACK_CHOICE_FILE = ".desktop-stack-choice";
export type StackChoice = "native" | "docker";

export async function readStackChoice(stackDir: string): Promise<StackChoice | null> {
  const raw = (await readPrivateFile(path.join(stackDir, STACK_CHOICE_FILE), 32))?.trim();
  return raw === "native" || raw === "docker" ? raw : null;
}

export async function writeStackChoice(stackDir: string, choice: StackChoice): Promise<void> {
  await writePrivateFile(path.join(stackDir, STACK_CHOICE_FILE), `${choice}\n`);
}

interface StackFacts {
  dockerStack: boolean;
  /** Docker itself is still installed, whether or not it is running now. */
  dockerInstalled: boolean;
  choice: StackChoice | null;
}

/**
 * Which stack runs This computer. A Mac that never used Docker, or no longer has it, goes native;
 * one with a Docker stack keeps it unless the person agreed to move ("ask" means they have not
 * been asked yet).
 */
export function chooseStack(
  input: StackFacts & { eligible: boolean; nativeStack: boolean },
): StackChoice | "ask" {
  if (!input.eligible) return "docker";
  if (input.nativeStack || !input.dockerStack || !input.dockerInstalled) return "native";
  return input.choice ?? "ask";
}

/**
 * Only a move the person accepted copies data, and only while Docker is there to copy from. A
 * native stack that started because Docker was gone never imports, so a later reinstall of
 * Docker cannot replace its database with the old one.
 */
export function moveAccepted(input: StackFacts): boolean {
  return input.dockerStack && input.dockerInstalled && input.choice === "native";
}

export function stackExists(stackDir: string, exists: (file: string) => boolean) {
  return {
    dockerStack: exists(path.join(stackDir, STACK_COMPOSE_FILE)),
    nativeStack: exists(path.join(stackDir, NATIVE_PORTS_FILE)),
  };
}

const DOCKER_TIMEOUT_MS = 60_000;
const DUMP_TIMEOUT_MS = 60 * 60_000;
const READY_ATTEMPTS = 30;

// The runtime role must exist before the restore, since the dump grants to it and its policies
// name it. A move cut short may have created it already.
const RUNTIME_ROLE_SQL = `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    CREATE ROLE rakazo_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
`;
// Inside the Docker database container, which knows its own owner and database names.
const DUMP_SCRIPT = 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom';

export interface PipedCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Streams one command's output into another's input; both must succeed. */
export type PipeCommands = (
  from: PipedCommand,
  to: PipedCommand,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal; onLine: (line: string) => void },
) => Promise<void>;

export const pipeCommands: PipeCommands = (from, to, options) =>
  new Promise((resolve, reject) => {
    const spawnOptions = (command: PipedCommand) => ({
      cwd: options.cwd,
      env: command.env,
      signal: options.signal,
      timeout: options.timeoutMs,
      shell: false,
    });
    const producer = spawn(from.command, from.args, {
      ...spawnOptions(from),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const consumer = spawn(to.command, to.args, {
      ...spawnOptions(to),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A consumer that exits early closes its input; its own exit code reports why.
    consumer.stdin.on("error", () => undefined);
    producer.stdout.pipe(consumer.stdin);
    const failures: string[] = [];
    let pending = 2;
    const pair = [
      [producer, from],
      [consumer, to],
    ] as const;
    // One side failing would leave the other blocked on a full or empty pipe until the timeout.
    const fail = (message: string) => {
      failures.push(message);
      for (const [child] of pair)
        if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    for (const [child, command] of pair) {
      for (const stream of [child.stderr, child === consumer ? consumer.stdout : null]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (text: string) => {
          for (const line of text.split(/\r?\n/)) if (line) options.onLine(line);
        });
      }
      child.once("error", (error) => fail(error.message));
      child.once("close", (code) => {
        if (code !== 0 && failures.length === 0)
          fail(`${path.basename(command.command)} ${command.args[0]} exited with code ${code}`);
        if (--pending > 0) return;
        // The first failure is the cause; the other side was stopped because of it.
        if (failures.length > 0) reject(new Error(failures[0]));
        else resolve();
      });
    }
  });

export interface DockerMoveDeps {
  stackDir: string;
  platform: string;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  run: RunDocker;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pipe?: PipeCommands;
}

/** Whether Docker answers now; the move is only offered when it does. */
export async function dockerRunning(deps: Omit<DockerMoveDeps, "sleep">): Promise<boolean> {
  const binary = resolveDockerBinary(deps.platform, deps.env, deps.exists);
  if (binary === null) return false;
  const info = await deps.run(binary, ["info", "--format", "{{.ServerVersion}}"], {
    cwd: deps.stackDir,
    env: dockerSpawnEnv(deps.platform, deps.env, binary),
    timeoutMs: 20_000,
  });
  return info.code === 0;
}

/**
 * Copies the Docker stack's database and data into the native stack, then stops (not removes)
 * the Docker stack; if any step fails, the services it stopped are started again. The database
 * travels as a logical dump streamed through the app from one database's own tools to the
 * other's, so the two need only share a major version and neither needs a password.
 */
export async function moveDockerStack(deps: DockerMoveDeps, target: DockerImportTarget) {
  const binary = resolveDockerBinary(deps.platform, deps.env, deps.exists);
  if (binary === null) throw new Error("Docker is not installed");
  const docker = async (args: string[], timeoutMs = DOCKER_TIMEOUT_MS, signal = target.signal) => {
    const result = await deps.run(binary, args, {
      cwd: deps.stackDir,
      env: dockerSpawnEnv(deps.platform, deps.env, binary),
      timeoutMs,
      signal,
      onLine: target.onLine,
    });
    if (result.code !== 0)
      throw new Error(`docker ${args.slice(0, 7).join(" ")} exited with code ${result.code}`);
    return result.stdout;
  };
  const composeArgs = [
    "compose",
    "--env-file",
    STACK_ENV_FILE,
    "-f",
    STACK_COMPOSE_FILE,
    "--project-name",
    STACK_PROJECT_NAME,
  ];
  const compose = (args: string[], timeoutMs?: number, signal?: AbortSignal) =>
    docker([...composeArgs, ...args], timeoutMs, signal);

  const services = ["web", "api", "worker", "supervisor"];
  target.onLine("Stopping the Docker services");
  try {
    await compose(["stop", ...services]);
    await compose(["start", "postgres"]);
    for (let attempt = 0; ; attempt += 1) {
      const ready = await compose(["exec", "-T", "postgres", "pg_isready", "-q"]).then(
        () => true,
        () => false,
      );
      if (ready) break;
      if (attempt >= READY_ATTEMPTS || target.signal.aborted)
        throw new Error("The Docker database did not start");
      await deps.sleep(1_000, target.signal);
    }

    target.onLine("Copying the database");
    const inDatabase = (args: string[]) => [
      "exec",
      "--interactive",
      target.container,
      ...args,
      "-U",
      target.user,
      "-d",
      target.database,
    ];
    const role = await deps.run(target.cli, inDatabase(["psql", "-v", "ON_ERROR_STOP=1", "-q"]), {
      cwd: deps.stackDir,
      env: target.env,
      timeoutMs: DOCKER_TIMEOUT_MS,
      signal: target.signal,
      input: RUNTIME_ROLE_SQL,
    });
    if (role.code !== 0) throw new Error(`psql exited with code ${role.code}`);
    await (deps.pipe ?? pipeCommands)(
      {
        command: binary,
        args: [...composeArgs, "exec", "-T", "postgres", "bash", "-c", DUMP_SCRIPT],
        env: dockerSpawnEnv(deps.platform, deps.env, binary),
      },
      {
        command: target.cli,
        args: inDatabase(["pg_restore", "--no-owner", "--exit-on-error"]),
        env: target.env,
      },
      {
        cwd: deps.stackDir,
        timeoutMs: DUMP_TIMEOUT_MS,
        signal: target.signal,
        onLine: target.onLine,
      },
    );

    target.onLine("Copying bot files");
    const api = (await compose(["ps", "--all", "--quiet", "api"])).trim().split("\n")[0];
    if (!api) throw new Error("The Docker stack has no API container to copy files from");
    await rm(target.dataDir, { recursive: true, force: true });
    await mkdir(target.dataDir, { recursive: true, mode: 0o700 });
    await docker(["cp", `${api}:/data/.`, target.dataDir], DUMP_TIMEOUT_MS);
  } catch (error) {
    // Even after a cancel, the Docker services go back to running; the move's error is what counts.
    await compose(["start", ...services], undefined, AbortSignal.timeout(DOCKER_TIMEOUT_MS)).catch(
      () => undefined,
    );
    throw error;
  }

  target.onLine("Stopping the Docker stack");
  // The data is already copied, so a stack that does not stop cleanly does not undo the move.
  await compose(["stop"]).catch((error: Error) =>
    target.onLine(`Could not stop the Docker stack: ${error.message}`),
  );
}
