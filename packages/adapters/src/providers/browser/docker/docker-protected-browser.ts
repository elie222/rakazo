import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { deadlineSignal } from "@rakazo/core";
import { bestEffort, getLogger } from "@rakazo/logging";
import type {
  ProtectedBrowserLauncher,
  ProtectedBrowserRequest,
  ProtectedBrowserResult,
} from "../../../browser/protected-browser.js";
import { ProtectedBrowserError } from "../../../browser/protected-browser.js";
import { createProtectedBrowserProxy } from "./protected-browser-proxy.js";

const docker = promisify(execFile);
// The daemon reserves these names atomically across all API replicas using its socket.
const CONTAINER_NAMES = ["rakazo-protected-browser-1", "rakazo-protected-browser-2"];
const SLOT_LABEL = "com.rakazo.protected-browser";
const BROWSER_TIMEOUT_MS = 60_000;
const ABANDONED_AFTER_MS = 2 * BROWSER_TIMEOUT_MS;
const MAX_BYTES = 2_000_000;
const engineEnvironment = { PATH: "/usr/local/bin:/usr/bin:/bin" };

function runDocker(engine: string[], ...args: string[]) {
  return docker("docker", [...engine, ...args], {
    signal: deadlineSignal(5_000),
    killSignal: "SIGKILL",
    env: engineEnvironment,
  });
}

async function recoverSlot(engine: string[], name: string): Promise<boolean> {
  try {
    const { stdout } = await runDocker(
      engine,
      "container",
      "inspect",
      "--format",
      `{{.Id}} {{.State.Status}} {{.Created}} {{index .Config.Labels "${SLOT_LABEL}"}}`,
      name,
    );
    const [id, status, created, label] = stdout.trim().split(" ");
    if (
      !id ||
      !/^[a-f0-9]{64}$/.test(id) ||
      status !== "created" ||
      label !== "true" ||
      !created ||
      !(Date.parse(created) <= Date.now() - ABANDONED_AFTER_MS)
    )
      return false;
    // The ID cannot be reused by another reservation and Docker refuses to remove a running container.
    await runDocker(engine, "rm", id);
    return true;
  } catch {
    // A competing replica may already have removed it. Retry the atomic name reservation.
    return true;
  }
}

async function runContainer(engine: string[], id: string, input: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const child = spawn("docker", [...engine, "start", "--attach", "--interactive", id], {
    signal,
    killSignal: "SIGKILL",
    env: engineEnvironment,
    stdio: ["pipe", "pipe", "ignore"],
  });
  // A failed start can close its input while the first write is pending.
  child.stdin.on("error", () => child.kill("SIGKILL"));
  const done = once(child, "close", { signal });
  child.stdin.end(input);
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) child.kill("SIGKILL");
    else chunks.push(chunk);
  });
  const [code] = await done;
  if (bytes > MAX_BYTES) throw new ProtectedBrowserError("invalid-output");
  if (code === 10) throw new ProtectedBrowserError("sign-in-rejected");
  if (code !== 0) throw new ProtectedBrowserError("container-exit");
  let result: ProtectedBrowserResult;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProtectedBrowserError("invalid-output");
  }
  if (
    !Array.isArray(result?.storageState?.cookies) ||
    !Array.isArray(result?.storageState?.origins)
  ) {
    throw new ProtectedBrowserError("invalid-output");
  }
  return result;
}

/**
 * Deploy against a trusted Linux engine with nested user namespaces and a shared socket directory.
 * Generate seccompProfile with infra/sandboxes/protected-browser/seccomp-profile.sh.
 */
export function createProtectedBrowserLauncher({
  image,
  seccompProfile,
}: {
  image: string;
  seccompProfile: string;
}): ProtectedBrowserLauncher {
  if (!isAbsolute(seccompProfile)) throw new Error("An absolute seccomp profile path is required.");
  return async (request: ProtectedBrowserRequest, parent?: AbortSignal) => {
    const signal = deadlineSignal(BROWSER_TIMEOUT_MS, parent);
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > MAX_BYTES) throw new ProtectedBrowserError("invalid-output");
    let directory: string | undefined;
    let container: { id: string; engine: string[] } | undefined;
    let completed = false;
    let phase: "proxy-setup" | "container-create" | "container-run" = "proxy-setup";
    const proxy = createProtectedBrowserProxy();
    try {
      directory = await mkdtemp(join(tmpdir(), "rakazo-browser-"));
      const engine = ["--host=unix:///var/run/docker.sock", "--config", directory];
      const mount = join(directory, "proxy");
      await mkdir(mount, { mode: 0o755 });
      const socket = join(mount, "egress.sock");
      proxy.server.listen(socket);
      await once(proxy.server, "listening", { signal });
      await chmod(socket, 0o666);

      phase = "container-create";
      slots: for (const name of CONTAINER_NAMES) {
        for (const recover of [true, false]) {
          signal.throwIfAborted();
          try {
            // Let create report the ID even if the caller disconnects, so cleanup can remove it.
            const { stdout } = await runDocker(
              engine,
              "create",
              "--name",
              name,
              `--label=${SLOT_LABEL}=true`,
              "--interactive",
              "--init",
              "--pull=never",
              "--rm",
              "--user=1001:1001",
              "--network=none",
              "--read-only",
              "--cap-drop=ALL",
              "--security-opt=no-new-privileges",
              `--security-opt=seccomp=${seccompProfile}`,
              "--log-driver=none",
              "--memory=1g",
              "--pids-limit=256",
              "--cpus=2",
              "--shm-size=128m",
              "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
              `--mount=type=bind,source=${mount},target=/run/protected-browser,readonly`,
              "--env=HOME=/tmp",
              "--env=PROTECTED_BROWSER_EGRESS=1",
              "--",
              image,
            );
            container = { id: stdout.trim(), engine };
            break slots;
          } catch (error) {
            const stderr = (error as { stderr?: string }).stderr;
            if (!stderr?.includes(`The container name "/${name}" is already in use`)) throw error;
            if (!recover || !(await recoverSlot(engine, name))) break;
          }
        }
      }
      if (!container) throw new ProtectedBrowserError("capacity");
      phase = "container-run";
      const result = await runContainer(engine, container.id, input, signal);
      completed = true;
      return result;
    } catch (error) {
      // Engine errors may carry arguments and captured output.
      const failure = signal.aborted
        ? new ProtectedBrowserError("timeout")
        : error instanceof ProtectedBrowserError
          ? error
          : new ProtectedBrowserError(
              phase === "container-run" ? "container-exit" : "configuration",
            );
      if (failure.code !== "sign-in-rejected" && failure.code !== "capacity") {
        getLogger().warn("Protected browser launcher failed", { code: failure.code, phase });
      }
      throw failure;
    } finally {
      proxy.close();
      if (container && !completed)
        await bestEffort(
          "remove protected browser container",
          runDocker(container.engine, "rm", "--force", container.id).then(
            () => undefined,
            (error: { stderr?: string }) => {
              if (!error.stderr?.includes("No such container")) {
                throw new Error("Protected browser container removal failed.");
              }
            },
          ),
        );
      if (directory) {
        await bestEffort(
          "remove protected browser directory",
          rm(directory, { recursive: true, force: true }).catch(() => {
            throw new Error("Protected browser directory removal failed.");
          }),
        );
      }
    }
  };
}
