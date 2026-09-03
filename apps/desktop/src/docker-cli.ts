import { spawn } from "node:child_process";
import path from "node:path";
import type { DesktopSetupLink } from "@rakazo/contracts";

/** Pages the setup window may open when Docker is missing. Nothing is ever installed by the app. */
export const DOCKER_INSTALL_LINKS: Record<DesktopSetupLink, string> = {
  "docker-desktop": "https://www.docker.com/products/docker-desktop/",
  orbstack: "https://orbstack.dev/",
  "docker-engine": "https://docs.docker.com/engine/install/",
};

export function isDesktopSetupLink(value: unknown): value is DesktopSetupLink {
  return typeof value === "string" && Object.hasOwn(DOCKER_INSTALL_LINKS, value);
}

/**
 * Where the docker CLI usually lives. GUI launches on macOS get a minimal PATH, so the
 * well-known install locations come before whatever PATH happens to contain.
 */
export function dockerBinaryCandidates(platform: string, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (platform === "darwin") {
    candidates.push(
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker",
    );
    if (env.HOME) candidates.push(path.join(env.HOME, ".orbstack", "bin", "docker"));
  } else if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    candidates.push(
      path.win32.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe"),
    );
  } else {
    candidates.push("/usr/bin/docker", "/usr/local/bin/docker");
  }
  const binary = platform === "win32" ? "docker.exe" : "docker";
  const joiner = platform === "win32" ? path.win32 : path.posix;
  for (const entry of (env.PATH ?? "").split(platform === "win32" ? ";" : ":")) {
    if (entry.trim() !== "") candidates.push(joiner.join(entry, binary));
  }
  return [...new Set(candidates)];
}

/**
 * `RAKAZO_DOCKER_BINARY` is a test hook and the only candidate when set, so a
 * fake docker in CI can never fall through to a real daemon.
 */
export function resolveDockerBinary(
  platform: string,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean,
): string | null {
  const override = env.RAKAZO_DOCKER_BINARY?.trim();
  if (override) return exists(override) ? override : null;
  return dockerBinaryCandidates(platform, env).find((candidate) => exists(candidate)) ?? null;
}

const SPAWN_ENV_ALLOWLIST = [
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "XDG_RUNTIME_DIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
];
const WIN32_ENV_ALLOWLIST = ["SystemRoot", "SystemDrive", "APPDATA", "LOCALAPPDATA", "ProgramData"];

/**
 * Compose interpolates the process environment into the stack, so only what docker
 * itself needs is passed through. A developer's shell API keys must never reach `.env`
 * interpolation or a container.
 */
export function dockerSpawnEnv(
  platform: string,
  env: NodeJS.ProcessEnv,
  dockerBinary: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const names =
    platform === "win32" ? [...SPAWN_ENV_ALLOWLIST, ...WIN32_ENV_ALLOWLIST] : SPAWN_ENV_ALLOWLIST;
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") result[name] = value;
  }
  const separator = platform === "win32" ? ";" : ":";
  const dockerDir = (platform === "win32" ? path.win32 : path.posix).dirname(dockerBinary);
  const basePath = env.PATH ?? "";
  result.PATH = basePath === "" ? dockerDir : `${dockerDir}${separator}${basePath}`;
  return { ...result, ...extra };
}

export interface RunDockerOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Receives each complete stdout or stderr line as it arrives. */
  onLine?: (line: string) => void;
}

export interface RunDockerResult {
  /** Exit status; 124 after the timeout, 130 after an abort. */
  code: number;
  stdout: string;
  stderr: string;
}

export type RunDocker = (
  binary: string,
  args: string[],
  options: RunDockerOptions,
) => Promise<RunDockerResult>;

/**
 * Runs the docker CLI with a fixed argv (never a shell), a bounded lifetime, and
 * process-group termination on timeout or abort. Mirrors the sandbox adapter's runCommand.
 */
export function runDocker(
  binary: string,
  args: string[],
  options: RunDockerOptions,
): Promise<RunDockerResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const captured = { stdout: "", stderr: "" };
    const pending = { stdout: "", stderr: "" };
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, ...captured });
    };
    const terminate = (code: number) => {
      killProcessTree(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(code);
    };
    const abort = () => terminate(130);
    const timer = setTimeout(() => terminate(124), options.timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });

    const emit = (raw: string) => {
      // Docker progress rewrites lines with carriage returns; keep the final rendering.
      const line = raw.split("\r").pop()?.trimEnd() ?? "";
      if (line !== "") options.onLine?.(line);
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        captured[stream] += text;
        const parts = (pending[stream] + text).split("\n");
        pending[stream] = parts.pop() ?? "";
        for (const part of parts) emit(part);
      });
    }
    child.on("error", (error) => {
      captured.stderr += error.message;
      finish(1);
    });
    child.on("close", (code) => {
      emit(pending.stdout);
      emit(pending.stderr);
      finish(code ?? 1);
    });
    if (options.signal?.aborted) abort();
  });
}

function killProcessTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process exited between the timeout and termination attempt.
    }
  }
}

export type DockerFailureKind =
  | "daemon-down"
  | "socket-permission"
  | "compose-missing"
  | "image-not-found"
  | "network"
  | "port-in-use"
  | "other";

const DAEMON_DOWN = [
  "cannot connect to the docker daemon",
  "is the docker daemon running",
  "error during connect",
  "docker desktop is starting",
  "the system cannot find the file specified",
];
const SOCKET_PERMISSION = [
  "permission denied while trying to connect",
  "got permission denied",
  "connect: permission denied",
];
const COMPOSE_MISSING = ["'compose' is not a docker command", "unknown command: docker compose"];
const IMAGE_NOT_FOUND = [
  "manifest unknown",
  "pull access denied",
  "not found: manifest",
  "no matching manifest",
  "repository does not exist",
];
const NETWORK = [
  "no such host",
  "tls handshake timeout",
  "i/o timeout",
  "temporary failure in name resolution",
  "connection refused",
  "network is unreachable",
  "context deadline exceeded",
];
const PORT_IN_USE = ["address already in use", "port is already allocated", "bind for 127.0.0.1"];

/** Docker output can contain paths and hostnames, so callers map kinds to fixed messages. */
export function classifyDockerFailure(output: string): DockerFailureKind {
  const text = output.toLowerCase();
  const matches = (needles: string[]) => needles.some((needle) => text.includes(needle));
  if (matches(SOCKET_PERMISSION)) return "socket-permission";
  if (matches(DAEMON_DOWN)) return "daemon-down";
  if (matches(COMPOSE_MISSING)) return "compose-missing";
  if (matches(PORT_IN_USE)) return "port-in-use";
  if (matches(IMAGE_NOT_FOUND)) return "image-not-found";
  if (matches(NETWORK)) return "network";
  return "other";
}

/** `up --wait --wait-timeout` needs Compose 2.17; older plugins get a plain `up -d`. */
export function composeSupportsWaitTimeout(versionText: string): boolean {
  const match = versionText.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 17);
}
