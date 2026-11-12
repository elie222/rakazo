// Moving an existing Docker This computer stack to the stack that runs without Docker. Asked once;
// the Docker stack is only stopped, never removed, so nothing is lost if the move fails.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RunDocker } from "./docker-cli.js";
import { dockerSpawnEnv, resolveDockerBinary } from "./docker-cli.js";
import { STACK_COMPOSE_FILE, STACK_ENV_FILE, STACK_PROJECT_NAME } from "./local-stack.js";
import type { DockerImportTarget } from "./native-stack.js";
import { POSTGRES_DIR } from "./native-stack.js";
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

/**
 * Which stack runs This computer. A Mac that never used Docker goes native; one with a Docker
 * stack keeps it unless the person agreed to move ("ask" means they have not been asked yet).
 */
export function chooseStack(input: {
  eligible: boolean;
  dockerStack: boolean;
  nativeStack: boolean;
  choice: StackChoice | null;
}): StackChoice | "ask" {
  if (!input.eligible) return "docker";
  if (input.nativeStack || !input.dockerStack) return "native";
  return input.choice ?? "ask";
}

export function stackExists(stackDir: string, exists: (file: string) => boolean) {
  return {
    dockerStack: exists(path.join(stackDir, STACK_COMPOSE_FILE)),
    nativeStack: exists(path.join(stackDir, POSTGRES_DIR, "PG_VERSION")),
  };
}

const DOCKER_TIMEOUT_MS = 60_000;
const DUMP_TIMEOUT_MS = 60 * 60_000;
const READY_ATTEMPTS = 30;

// Runs inside the Docker database container, which has the client tools the native database
// lacks: the runtime role first (its grants and policies are in the dump), then dump into restore.
// PG* point at the native database, so the dump names the container's own socket and port.
const RESTORE_SCRIPT = `set -euo pipefail
psql -v ON_ERROR_STOP=1 -q -c "CREATE ROLE rakazo_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"
pg_dump -h /var/run/postgresql -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom | pg_restore --no-owner --exit-on-error -d "$PGDATABASE"`;

export interface DockerMoveDeps {
  stackDir: string;
  platform: string;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  run: RunDocker;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
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
 * travels as a logical dump, so the two need only share a major version; the native database is
 * reached from the container at host.docker.internal.
 */
export async function moveDockerStack(deps: DockerMoveDeps, target: DockerImportTarget) {
  const binary = resolveDockerBinary(deps.platform, deps.env, deps.exists);
  if (binary === null) throw new Error("Docker is not installed");
  const docker = async (
    args: string[],
    timeoutMs = DOCKER_TIMEOUT_MS,
    extra = {},
    signal = target.signal,
  ) => {
    const result = await deps.run(binary, args, {
      cwd: deps.stackDir,
      env: dockerSpawnEnv(deps.platform, deps.env, binary, extra),
      timeoutMs,
      signal,
      onLine: target.onLine,
    });
    if (result.code !== 0)
      throw new Error(`docker ${args.slice(0, 7).join(" ")} exited with code ${result.code}`);
    return result.stdout;
  };
  const compose = (
    args: string[],
    timeoutMs?: number,
    extra?: Record<string, string>,
    signal?: AbortSignal,
  ) =>
    docker(
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
      extra,
      signal,
    );

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
    await compose(
      [
        "exec",
        "-T",
        ...["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"].flatMap((name) => [
          "-e",
          name,
        ]),
        "postgres",
        "bash",
        "-c",
        RESTORE_SCRIPT,
      ],
      DUMP_TIMEOUT_MS,
      {
        PGHOST: "host.docker.internal",
        PGPORT: String(target.port),
        PGUSER: target.user,
        PGPASSWORD: target.password,
        PGDATABASE: target.database,
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
    await compose(
      ["start", ...services],
      undefined,
      undefined,
      AbortSignal.timeout(DOCKER_TIMEOUT_MS),
    ).catch(() => undefined);
    throw error;
  }

  target.onLine("Stopping the Docker stack");
  await compose(["stop"]);
}
