import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** No credentials or .env loading: isolated local Docker + HTTP model fixture only. */
async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const imageArg = process.argv.slice(2).find((arg) => arg.startsWith("--image="));
  const subnetArg = process.argv.slice(2).find((arg) => arg.startsWith("--subnet="));
  const unknown = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--image=") && !arg.startsWith("--subnet="));
  if (unknown.length)
    throw new Error(
      "Usage: computer-replay.ts [--image=rakazo/computer:local] [--subnet=unused-private-CIDR]",
    );
  const image = imageArg?.slice("--image=".length) || "rakazo/computer:local";
  execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  const directory = await mkdtemp(path.join(tmpdir(), "rakazo-computer-replay-"));
  // Retain only local process/Docker discovery settings. In particular, do not
  // inherit provider, telemetry, proxy credentials, or the maintainer's data dir.
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    RUN_COMPUTER_REPLAY_DOCKER: "1",
    DATA_DIR: path.join(directory, "data"),
    RAKAZO_COMPUTER_IMAGE: image,
    SANDBOX_SUPERVISOR_TOKEN: "computer-replay-fixture-token-32chars",
    SANDBOX_SCREEN_NETWORK: "published",
    SANDBOX_SCREEN_HOST: "127.0.0.1",
    SANDBOX_CONTROL_VIA_LOOPBACK: "true",
    LOG_LEVEL: "off",
    ...(subnetArg ? { COMPUTER_REPLAY_SUBNET: subnetArg.slice("--subnet=".length) } : {}),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(root, "node_modules/vitest/vitest.mjs"),
          "run",
          "--root",
          root,
          "packages/testkit/src/computer-replay.docker.test.ts",
        ],
        {
          env,
          cwd: directory,
          stdio: "inherit",
        },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Computer replay failed (exit ${code})`)),
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
