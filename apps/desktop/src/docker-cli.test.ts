import { describe, expect, it } from "vitest";
import {
  classifyDockerFailure,
  composeSupportsWaitTimeout,
  DOCKER_INSTALL_LINKS,
  dockerBinaryCandidates,
  dockerSpawnEnv,
  isDesktopSetupLink,
  resolveDockerBinary,
  runDocker,
} from "./docker-cli.js";

describe("docker install links", () => {
  it("only opens the three known pages over https", () => {
    for (const url of Object.values(DOCKER_INSTALL_LINKS)) expect(url).toMatch(/^https:\/\//);
    expect(isDesktopSetupLink("orbstack")).toBe(true);
    expect(isDesktopSetupLink("toString")).toBe(false);
    expect(isDesktopSetupLink("https://evil.example")).toBe(false);
    expect(isDesktopSetupLink(42)).toBe(false);
  });
});

describe("dockerBinaryCandidates", () => {
  it("checks the macOS install locations before PATH", () => {
    const candidates = dockerBinaryCandidates("darwin", {
      HOME: "/Users/me",
      PATH: "/usr/bin:/usr/local/bin",
    });
    expect(candidates).toEqual([
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/Users/me/.orbstack/bin/docker",
      "/usr/bin/docker",
    ]);
  });

  it("uses Program Files and PATH entries on Windows", () => {
    const candidates = dockerBinaryCandidates("win32", {
      ProgramFiles: "C:\\Program Files",
      PATH: "C:\\Windows\\system32;C:\\tools",
    });
    expect(candidates).toEqual([
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Windows\\system32\\docker.exe",
      "C:\\tools\\docker.exe",
    ]);
  });

  it("falls back to the usual Linux paths and skips empty PATH entries", () => {
    expect(dockerBinaryCandidates("linux", { PATH: "/snap/bin::/usr/bin" })).toEqual([
      "/usr/bin/docker",
      "/usr/local/bin/docker",
      "/snap/bin/docker",
    ]);
  });
});

describe("resolveDockerBinary", () => {
  it("returns the first existing candidate", () => {
    const binary = resolveDockerBinary("linux", { PATH: "/opt/bin" }, (file) =>
      file.startsWith("/opt/"),
    );
    expect(binary).toBe("/opt/bin/docker");
  });

  it("returns null when nothing exists", () => {
    expect(resolveDockerBinary("darwin", { HOME: "/Users/me" }, () => false)).toBeNull();
  });

  it("treats RAKAZO_DOCKER_BINARY as the only candidate", () => {
    const env = { RAKAZO_DOCKER_BINARY: "/fake/docker", PATH: "/usr/bin" };
    expect(resolveDockerBinary("linux", env, (file) => file === "/fake/docker")).toBe(
      "/fake/docker",
    );
    // A real docker on PATH must not be used when the override points nowhere.
    expect(resolveDockerBinary("linux", env, (file) => file === "/usr/bin/docker")).toBeNull();
  });
});

describe("dockerSpawnEnv", () => {
  it("passes only what docker needs and prepends the docker directory to PATH", () => {
    const env = dockerSpawnEnv(
      "darwin",
      {
        HOME: "/Users/me",
        PATH: "/usr/bin:/bin",
        OPENROUTER_API_KEY: "sk-secret",
        POSTGRES_PASSWORD: "leak",
        DOCKER_HOST: "unix:///Users/me/.orbstack/run/docker.sock",
        LANG: "en_US.UTF-8",
      },
      "/Users/me/.orbstack/bin/docker",
      { RAKAZO_IMAGE_TAG: "v1.2.3" },
    );
    expect(env).toEqual({
      HOME: "/Users/me",
      PATH: "/Users/me/.orbstack/bin:/usr/bin:/bin",
      DOCKER_HOST: "unix:///Users/me/.orbstack/run/docker.sock",
      LANG: "en_US.UTF-8",
      RAKAZO_IMAGE_TAG: "v1.2.3",
    });
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(env).not.toHaveProperty("POSTGRES_PASSWORD");
  });

  it("keeps the Windows system variables docker.exe depends on", () => {
    const env = dockerSpawnEnv(
      "win32",
      { SystemRoot: "C:\\Windows", APPDATA: "C:\\Users\\me\\AppData\\Roaming", PATH: "" },
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    );
    expect(env).toEqual({
      SystemRoot: "C:\\Windows",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      PATH: "C:\\Program Files\\Docker\\Docker\\resources\\bin",
    });
  });
});

describe("classifyDockerFailure", () => {
  it.each([
    ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock", "daemon-down"],
    [
      "error during connect: Head http://%2F%2F.%2Fpipe: open //./pipe: file not found",
      "daemon-down",
    ],
    ["permission denied while trying to connect to the Docker daemon socket", "socket-permission"],
    ["docker: 'compose' is not a docker command.", "compose-missing"],
    ["Error response from daemon: manifest unknown", "image-not-found"],
    ["pull access denied for ghcr.io/x/y, repository does not exist", "image-not-found"],
    ["Get https://ghcr.io/v2/: dial tcp: lookup ghcr.io: no such host", "network"],
    ["net/http: TLS handshake timeout", "network"],
    ["Bind for 127.0.0.1:5173 failed: port is already allocated", "port-in-use"],
    ["listen tcp 127.0.0.1:3100: bind: address already in use", "port-in-use"],
    ["something else entirely", "other"],
  ])("classifies %j as %s", (output, kind) => {
    expect(classifyDockerFailure(output)).toBe(kind);
  });
});

describe("composeSupportsWaitTimeout", () => {
  it.each([
    ["2.17.0", true],
    ["v2.29.7", true],
    ["3.0.0", true],
    ["2.16.9", false],
    ["1.29.2", false],
    ["", false],
  ])("%s → %s", (version, supported) => {
    expect(composeSupportsWaitTimeout(version)).toBe(supported);
  });
});

describe("runDocker", () => {
  const node = process.execPath;
  const options = { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 };

  it("captures stdout, stderr, the exit code, and complete lines in order", async () => {
    const lines: string[] = [];
    const result = await runDocker(
      node,
      ["-e", 'process.stdout.write("a\\nb"); process.stderr.write("err\\n"); process.exit(3)'],
      { ...options, onLine: (line) => lines.push(line) },
    );
    expect(result).toEqual({ code: 3, stdout: "a\nb", stderr: "err\n" });
    expect(lines.sort()).toEqual(["a", "b", "err"]);
  });

  it("keeps the last rendering of carriage-return progress lines", async () => {
    const lines: string[] = [];
    await runDocker(node, ["-e", 'process.stdout.write("10%\\r50%\\r100%\\n")'], {
      ...options,
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(["100%"]);
  });

  it("kills a command that exceeds its timeout", async () => {
    const started = Date.now();
    const result = await runDocker(node, ["-e", "setInterval(() => {}, 1000)"], {
      ...options,
      timeoutMs: 300,
    });
    expect(result.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("honours an abort signal", async () => {
    const controller = new AbortController();
    const pending = runDocker(node, ["-e", "setInterval(() => {}, 1000)"], {
      ...options,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.code).toBe(130);
  });

  it("reports a missing binary as a failure instead of throwing", async () => {
    const result = await runDocker("/nonexistent/docker", ["info"], options);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ENOENT");
  });
});
