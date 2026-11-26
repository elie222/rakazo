import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { deadlineSignal } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type {
  ProtectedBrowserLauncher,
  ProtectedBrowserRequest,
  ProtectedBrowserResult,
} from "../../../browser/protected-browser.js";
import { createProtectedBrowserProxy } from "./protected-browser-proxy.js";

const docker = promisify(execFile);
const MAX_BYTES = 2_000_000;
const engineEnvironment = { PATH: "/usr/local/bin:/usr/bin:/bin" };
const failure = () => new Error("The protected browser operation failed.");

async function runContainer(engine: string[], name: string, input: string, signal: AbortSignal) {
  const child = spawn("docker", [...engine, "start", "--attach", "--interactive", name], {
    signal,
    env: engineEnvironment,
    stdio: ["pipe", "pipe", "ignore"],
  });
  // A failed start can close its input while the first write is pending.
  child.stdin.on("error", () => child.kill());
  const done = once(child, "close");
  child.stdin.end(input);
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) child.kill();
    else chunks.push(chunk);
  });
  const [code] = await done;
  if (code !== 0 || bytes > MAX_BYTES) throw failure();
  const result: ProtectedBrowserResult = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !Array.isArray(result.storageState?.cookies) ||
    !Array.isArray(result.storageState?.origins)
  ) {
    throw failure();
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
    const signal = deadlineSignal(60_000, parent);
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > MAX_BYTES) throw failure();
    const directory = await mkdtemp(join(tmpdir(), "rakazo-browser-"));
    const name = basename(directory);
    const engine = ["--host=unix:///var/run/docker.sock", "--config", directory];
    let completed = false;
    const proxy = createProtectedBrowserProxy();
    try {
      const mount = join(directory, "proxy");
      await mkdir(mount, { mode: 0o755 });
      const socket = join(mount, "egress.sock");
      proxy.server.listen(socket);
      await once(proxy.server, "listening", { signal });
      await chmod(socket, 0o666);

      await docker(
        "docker",
        [
          ...engine,
          "create",
          "--name",
          name,
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
        ],
        { signal, env: engineEnvironment },
      );
      const result = await runContainer(engine, name, input, signal);
      completed = true;
      return result;
    } catch {
      throw failure();
    } finally {
      proxy.close();
      if (!completed)
        await bestEffort(
          "remove protected browser container",
          docker("docker", [...engine, "rm", "--force", name], {
            signal: deadlineSignal(5_000),
            env: engineEnvironment,
          }).then(
            () => undefined,
            (error: { stderr?: string }) => {
              if (!error.stderr?.includes("No such container")) {
                throw new Error("Protected browser container removal failed.");
              }
            },
          ),
        );
      await rm(directory, { recursive: true, force: true });
    }
  };
}
