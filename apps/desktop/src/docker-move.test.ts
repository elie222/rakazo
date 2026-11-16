import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunDocker } from "./docker-cli.js";
import type { PipeCommands } from "./docker-move.js";
import {
  chooseStack,
  moveAccepted,
  moveDockerStack,
  pipeCommands,
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
  const base = {
    eligible: true,
    dockerStack: false,
    dockerInstalled: true,
    nativeStack: false,
    choice: null,
  };

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

  it("goes native without asking when Docker is no longer installed, and never imports", () => {
    const gone = { ...base, dockerStack: true, dockerInstalled: false };
    expect(chooseStack(gone)).toBe("native");
    expect(moveAccepted(gone)).toBe(false);
    // Docker installed again later: the native stack is kept and its data is not replaced.
    const back = { ...base, dockerStack: true, nativeStack: true };
    expect(chooseStack(back)).toBe("native");
    expect(moveAccepted(back)).toBe(false);
    // Installed but not running right now still asks (or keeps Docker); only the agreed move imports.
    expect(chooseStack({ ...base, dockerStack: true })).toBe("ask");
    expect(moveAccepted({ ...base, dockerStack: true, choice: "native" })).toBe(true);
  });

  it("detects each stack from its own files", async () => {
    const exists = (file: string) => file.endsWith("docker-compose.images.yml");
    expect(stackExists(dir, exists)).toEqual({ dockerStack: true, nativeStack: false });
  });
});

const target = (dataDir: string) => ({
  cli: "/usr/local/bin/container",
  container: "rakazo-postgres",
  env: { PATH: "/usr/bin:/bin" },
  user: "rakazo",
  database: "rakazo",
  dataDir,
  signal: new AbortController().signal,
  onLine: () => undefined,
});
const deps = (run: RunDocker, pipe: PipeCommands) => ({
  stackDir: dir,
  platform: "darwin",
  env: {},
  exists: (file: string) => file === "/usr/local/bin/docker",
  run,
  sleep: async () => undefined,
  pipe,
});
const compose = (args: string[]) =>
  args
    .filter((arg) => !["--env-file", ".env", "-f"].includes(arg))
    .slice(0, 6)
    .join(" ");

describe("moveDockerStack", () => {
  it("streams the dump into the native database through the app and copies the data", async () => {
    const calls: { binary: string; args: string[]; input?: string }[] = [];
    const run: RunDocker = async (binary, args, options) => {
      calls.push({ binary, args, input: options.input });
      if (args.at(-1) === "api" && args.includes("ps")) {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      if (args[0] === "cp") {
        await mkdir(args[2]!, { recursive: true });
        await writeFile(path.join(args[2]!, "homes"), "");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const piped: Parameters<PipeCommands>[] = [];
    const pipe: PipeCommands = async (...args) => {
      calls.push({ binary: "pipe", args: [] });
      piped.push(args);
    };
    const dataDir = path.join(dir, "data");
    await mkdir(dataDir);
    await writeFile(path.join(dataDir, "stale"), "");
    await moveDockerStack(deps(run, pipe), target(dataDir));

    expect(
      calls.map((call) =>
        call.binary === "/usr/local/bin/docker"
          ? compose(call.args)
          : `${call.binary} ${call.args.slice(0, 3).join(" ")}`.trim(),
      ),
    ).toEqual([
      "compose docker-compose.images.yml --project-name rakazo-desktop stop web",
      "compose docker-compose.images.yml --project-name rakazo-desktop start postgres",
      "compose docker-compose.images.yml --project-name rakazo-desktop exec -T",
      "/usr/local/bin/container exec --interactive rakazo-postgres",
      "pipe",
      "compose docker-compose.images.yml --project-name rakazo-desktop ps --all",
      `cp abc123:/data/. ${dataDir}`,
      "compose docker-compose.images.yml --project-name rakazo-desktop stop",
    ]);
    expect(calls[3]?.input).toContain("CREATE ROLE rakazo_app NOLOGIN NOSUPERUSER NOBYPASSRLS");
    const [from, to] = piped[0]!;
    expect(from.command).toBe("/usr/local/bin/docker");
    expect(from.args.slice(-6)).toEqual([
      "exec",
      "-T",
      "postgres",
      "bash",
      "-c",
      'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom',
    ]);
    expect(to).toEqual({
      command: "/usr/local/bin/container",
      args: [
        "exec",
        "--interactive",
        "rakazo-postgres",
        "pg_restore",
        "--no-owner",
        "--exit-on-error",
        "-U",
        "rakazo",
        "-d",
        "rakazo",
      ],
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(await readdir(dataDir)).toEqual(["homes"]);
  });

  it("keeps a finished move when the Docker stack does not stop cleanly", async () => {
    const lines: string[] = [];
    const run: RunDocker = async (_binary, args) => {
      if (args.at(-1) === "api" && args.includes("ps"))
        return { code: 0, stdout: "abc123\n", stderr: "" };
      const finalStop = args.at(-1) === "stop";
      return { code: finalStop ? 1 : 0, stdout: "", stderr: "" };
    };
    await expect(
      moveDockerStack(
        deps(run, async () => undefined),
        {
          ...target(path.join(dir, "data")),
          onLine: (line) => lines.push(line),
        },
      ),
    ).resolves.toBeUndefined();
    expect(lines.at(-1)).toMatch(/^Could not stop the Docker stack: .*exited with code 1$/);
  });

  it("stops at the first failing step and starts the Docker services again", async () => {
    const calls: string[][] = [];
    const run: RunDocker = async (_binary, args) => {
      calls.push(args);
      // The restart fails too; the restore's error is the one reported.
      const code = args.includes("web") && args.includes("start") ? 2 : 0;
      return { code, stdout: "", stderr: code ? "failed" : "" };
    };
    const pipe: PipeCommands = async () => {
      calls.push(["pipe"]);
      throw new Error("pg_restore exited with code 1");
    };
    await expect(moveDockerStack(deps(run, pipe), target(path.join(dir, "data")))).rejects.toThrow(
      "pg_restore exited with code 1",
    );
    expect(calls.some((args) => args[0] === "cp")).toBe(false);
    expect(calls.at(-2)).toEqual(["pipe"]);
    expect(calls.at(-1)?.slice(-5)).toEqual(["start", "web", "api", "worker", "supervisor"]);
  });
});

describe("pipeCommands", () => {
  const node = (script: string) => ({ command: process.execPath, args: ["-e", script], env: {} });
  const options = () => ({
    cwd: dir,
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    onLine: () => undefined,
  });

  it("streams one command's output into the other", async () => {
    const out = path.join(dir, "out");
    await pipeCommands(
      node("process.stdout.write('dump bytes')"),
      node(`process.stdin.pipe(require("fs").createWriteStream(${JSON.stringify(out)}))`),
      options(),
    );
    expect(await readFile(out, "utf8")).toBe("dump bytes");
  });

  it("stops a producer blocked on a full pipe once the consumer gives up", async () => {
    const started = Date.now();
    await expect(
      pipeCommands(
        node("const b = Buffer.alloc(1 << 20); for (;;) process.stdout.write(b)"),
        node("process.exit(4)"),
        options(),
      ),
    ).rejects.toThrow(/exited with code 4$/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("fails when either side fails", async () => {
    await expect(
      pipeCommands(node("process.exit(3)"), node("process.stdin.resume()"), options()),
    ).rejects.toThrow(/exited with code 3/);
    await expect(
      pipeCommands(node("process.stdout.write('x')"), node("process.exit(4)"), options()),
    ).rejects.toThrow(/exited with code 4/);
  });
});
