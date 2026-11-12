import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunDocker } from "./docker-cli.js";
import {
  chooseStack,
  moveDockerStack,
  readStackChoice,
  stackExists,
  writeStackChoice,
} from "./docker-move.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rakazo-move-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("chooseStack", () => {
  const base = { eligible: true, dockerStack: false, nativeStack: false, choice: null };

  it("keeps Docker wherever the native stack cannot run", () => {
    expect(chooseStack({ ...base, eligible: false })).toBe("docker");
    expect(chooseStack({ ...base, eligible: false, nativeStack: true, choice: "native" })).toBe(
      "docker",
    );
  });

  it("goes native on a Mac that never ran the Docker stack, or already moved", () => {
    expect(chooseStack(base)).toBe("native");
    expect(chooseStack({ ...base, dockerStack: true, nativeStack: true, choice: "docker" })).toBe(
      "native",
    );
  });

  it("asks a Docker user once, then follows the answer", async () => {
    const ask = { ...base, dockerStack: true };
    expect(chooseStack({ ...ask, choice: await readStackChoice(dir) })).toBe("ask");
    await writeStackChoice(dir, "docker");
    expect(chooseStack({ ...ask, choice: await readStackChoice(dir) })).toBe("docker");
    await writeStackChoice(dir, "native");
    expect(chooseStack({ ...ask, choice: await readStackChoice(dir) })).toBe("native");
  });

  it("detects each stack from its own files", async () => {
    const exists = (file: string) => file.endsWith("docker-compose.images.yml");
    expect(stackExists(dir, exists)).toEqual({ dockerStack: true, nativeStack: false });
  });
});

describe("moveDockerStack", () => {
  it("restores into the native database through the container and copies the data", async () => {
    const calls: { args: string[]; env: Record<string, string> }[] = [];
    const run: RunDocker = async (_binary, args, options) => {
      calls.push({ args, env: options.env });
      if (args.at(-1) === "api" && args.includes("ps")) {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      if (args[0] === "cp") {
        await mkdir(args[2]!, { recursive: true });
        await writeFile(path.join(args[2]!, "homes"), "");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const dataDir = path.join(dir, "data");
    await mkdir(dataDir);
    await writeFile(path.join(dataDir, "stale"), "");
    await moveDockerStack(
      {
        stackDir: dir,
        platform: "darwin",
        env: {},
        exists: (file) => file === "/usr/local/bin/docker",
        run,
        sleep: async () => undefined,
      },
      {
        port: 41234,
        user: "rakazo",
        password: "secret-owner-password",
        database: "rakazo",
        dataDir,
        signal: new AbortController().signal,
        onLine: () => undefined,
      },
    );

    const commands = calls.map((call) =>
      call.args
        .filter((arg) => !["--env-file", ".env", "-f"].includes(arg))
        .slice(0, 6)
        .join(" "),
    );
    expect(commands).toEqual([
      "compose docker-compose.images.yml --project-name rakazo-desktop stop web",
      "compose docker-compose.images.yml --project-name rakazo-desktop start postgres",
      "compose docker-compose.images.yml --project-name rakazo-desktop exec -T",
      "compose docker-compose.images.yml --project-name rakazo-desktop exec -T",
      "compose docker-compose.images.yml --project-name rakazo-desktop ps --all",
      `cp abc123:/data/. ${dataDir}`,
      "compose docker-compose.images.yml --project-name rakazo-desktop stop",
    ]);
    const restore = calls[3]!;
    expect(restore.env).toMatchObject({
      PGHOST: "host.docker.internal",
      PGPORT: "41234",
      PGPASSWORD: "secret-owner-password",
    });
    // The password travels in the environment, never on a command line.
    expect(calls.some((call) => call.args.join(" ").includes("secret-owner-password"))).toBe(false);
    expect(await readdir(dataDir)).toEqual(["homes"]);
  });

  it("stops at the first failing step without copying files or stopping the database", async () => {
    const calls: string[][] = [];
    const run: RunDocker = async (_binary, args) => {
      calls.push(args);
      const failed = args.includes("bash");
      return { code: failed ? 1 : 0, stdout: "", stderr: failed ? "pg_restore: error" : "" };
    };
    await expect(
      moveDockerStack(
        {
          stackDir: dir,
          platform: "darwin",
          env: {},
          exists: (file) => file === "/usr/local/bin/docker",
          run,
          sleep: async () => undefined,
        },
        {
          port: 41234,
          user: "rakazo",
          password: "pw",
          database: "rakazo",
          dataDir: path.join(dir, "data"),
          signal: new AbortController().signal,
          onLine: () => undefined,
        },
      ),
    ).rejects.toThrow(/exited with code 1/);
    expect(calls.some((args) => args[0] === "cp")).toBe(false);
    expect(calls.at(-1)).toContain("bash");
  });
});
