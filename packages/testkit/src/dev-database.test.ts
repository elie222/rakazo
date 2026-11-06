import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rakazo-dev-db-"));
  temporary.push(dir);
  await mkdir(path.join(dir, "scripts"));
  await mkdir(path.join(dir, "packages/db"), { recursive: true });
  await mkdir(path.join(dir, "bin"));
  await exec("git", ["init", "-q", dir]);
  await copyFile(path.join(root, "scripts/dev.mjs"), path.join(dir, "scripts/dev.mjs"));
  await copyFile(path.join(root, "scripts/pnpm.mjs"), path.join(dir, "scripts/pnpm.mjs"));
  await symlink(
    path.join(root, "packages/db/node_modules"),
    path.join(dir, "packages/db/node_modules"),
    "dir",
  );
  const marker = path.join(dir, "docker-called");
  await writeFile(path.join(dir, "bin/docker"), `#!/bin/sh\ntouch "$DOCKER_MARKER"\nexit 1\n`, {
    mode: 0o755,
  });
  const env = {
    PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: dir,
    WEB_PORT: "5173",
    API_PORT: "3100",
    DOCKER_MARKER: marker,
  };
  return { dir, env, marker };
}

describe("development database selection", () => {
  it("fails without starting another database when the configured one is unreachable", async () => {
    const { dir, env, marker } = await fixture();
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const result = await exec(process.execPath, [path.join(dir, "scripts/dev.mjs")], {
        env: { ...env, DATABASE_URL: `postgres://test:test@127.0.0.1:${port}/test` },
        timeout: 10000,
      }).then(
        () => undefined,
        (error: { stderr?: string }) => error,
      );
      expect(result?.stderr).toContain("The configured database does not accept a connection");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("tries the managed database when no database is configured", async () => {
    const { dir, env, marker } = await fixture();
    await expect(
      exec(process.execPath, [path.join(dir, "scripts/dev.mjs")], { env, timeout: 10000 }),
    ).rejects.toThrow();
    await expect(readFile(marker)).resolves.toBeDefined();
  });
});
