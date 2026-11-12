import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunDocker, RunDockerResult } from "./docker-cli.js";
import type { PinnedDownload, ResolveRuntimeDeps } from "./mac-runtime.js";
import {
  DownloadError,
  downloadVerified,
  installContainerRuntime,
  installPostgres,
  nativeStackEligible,
  pruneRuntimes,
  readServerBundle,
  resolveContainerRuntime,
  USER_CONTAINER_CLI,
  verifyRuntimeSignature,
  versionAtLeast,
} from "./mac-runtime.js";

const SIGNED = `Package "container-1.7.1-installer-signed.pkg":
   Status: signed by a developer certificate issued by Apple for distribution
   Notarization: trusted by the Apple notary service
   Signed with a trusted timestamp on: 2026-11-07 00:10:04 +0000
   Certificate Chain:
    1. Developer ID Installer: Apple Inc. - Containerization (UPBK2H6LZM)
       Expires: 2030-06-04 16:44:29 +0000
    2. Developer ID Certification Authority
    3. Apple Root CA
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rakazo-runtime-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ok = (stdout = ""): RunDockerResult => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1): RunDockerResult => ({ code, stdout: "", stderr: "failed" });

function bytesFetch(body: Uint8Array) {
  return async () => new Response(body);
}

function pinnedFor(body: Uint8Array, url = "https://example.test/file.bin"): PinnedDownload {
  return { url, sha256: createHash("sha256").update(body).digest("hex"), size: body.length };
}

function runtimeDeps(run: RunDocker, overrides: Partial<ResolveRuntimeDeps> = {}) {
  const lines: string[] = [];
  const deps: ResolveRuntimeDeps = {
    dir,
    run,
    fetch: async () => new Response("unexpected", { status: 500 }),
    env: {},
    signal: new AbortController().signal,
    onBytes: () => undefined,
    onLine: (line) => lines.push(line),
    uid: 501,
    exists: () => false,
    appRoot: path.join(dir, "vm"),
    logRoot: path.join(dir, "vm-logs"),
    ...overrides,
  };
  return { deps, lines };
}

describe("nativeStackEligible", () => {
  it.each([
    ["darwin", "arm64", "25.6.0", true],
    ["darwin", "arm64", "26.0.0", true],
    ["darwin", "arm64", "24.6.0", false],
    ["darwin", "x64", "25.6.0", false],
    ["linux", "arm64", "25.6.0", false],
    ["win32", "x64", "10.0.26100", false],
  ])("%s %s %s → %s", (platform, arch, release, expected) => {
    expect(nativeStackEligible({ platform, arch, release })).toBe(expected);
  });
});

describe("versionAtLeast", () => {
  it("compares dotted versions numerically", () => {
    expect(versionAtLeast("1.7.1", "1.7.0")).toBe(true);
    expect(versionAtLeast("1.10.0", "1.7.0")).toBe(true);
    expect(versionAtLeast("1.6.9", "1.7.0")).toBe(false);
    expect(versionAtLeast(undefined, "1.7.0")).toBe(false);
    expect(versionAtLeast("unknown", "1.7.0")).toBe(false);
  });
});

describe("downloadVerified", () => {
  const body = new TextEncoder().encode("pinned contents");

  it("moves a matching download into place and reports progress", async () => {
    const progress: number[] = [];
    const destination = path.join(dir, "file.bin");
    await downloadVerified(
      {
        fetch: bytesFetch(body),
        signal: new AbortController().signal,
        onBytes: (_, bytes) => progress.push(bytes),
      },
      "file",
      pinnedFor(body),
      destination,
    );
    expect(await readFile(destination, "utf8")).toBe("pinned contents");
    expect(progress.at(-1)).toBe(body.length);
  });

  it.each([
    ["a different hash", { sha256: "0".repeat(64) }],
    ["a different size", { size: 3 }],
  ])("rejects %s and leaves nothing behind", async (_, change) => {
    const destination = path.join(dir, "file.bin");
    await expect(
      downloadVerified(
        { fetch: bytesFetch(body), signal: new AbortController().signal, onBytes: () => undefined },
        "file",
        { ...pinnedFor(body), ...change },
        destination,
      ),
    ).rejects.toBeInstanceOf(DownloadError);
    expect(await readdir(dir)).toEqual([]);
  });

  it("turns HTTP and network failures into download errors", async () => {
    const deps = { signal: new AbortController().signal, onBytes: () => undefined };
    await expect(
      downloadVerified(
        { ...deps, fetch: async () => new Response("", { status: 404 }) },
        "file",
        pinnedFor(body),
        path.join(dir, "file.bin"),
      ),
    ).rejects.toBeInstanceOf(DownloadError);
    await expect(
      downloadVerified(
        {
          ...deps,
          fetch: async () => {
            throw new TypeError("fetch failed");
          },
        },
        "file",
        pinnedFor(body),
        path.join(dir, "file.bin"),
      ),
    ).rejects.toBeInstanceOf(DownloadError);
  });
});

describe("installers", () => {
  it("never unpacks a database download whose checksum does not match", async () => {
    const calls: string[][] = [];
    const run: RunDocker = async (binary, args) => {
      calls.push([binary, ...args]);
      return ok();
    };
    const { deps } = runtimeDeps(run, { fetch: bytesFetch(new TextEncoder().encode("tampered")) });
    await expect(installPostgres(deps)).rejects.toBeInstanceOf(DownloadError);
    expect(calls).toEqual([]);
    expect(await readdir(path.join(dir, "downloads"))).toEqual([]);
  });

  it("checks the runtime installer's signature before expanding it", async () => {
    const body = new TextEncoder().encode("installer");
    const calls: string[][] = [];
    const run: RunDocker = async (binary, args) => {
      calls.push([binary, ...args]);
      return ok(SIGNED.replace("Containerization (UPBK2H6LZM)", "Someone Else (AAAAAAAAAA)"));
    };
    const { deps } = runtimeDeps(run, { fetch: bytesFetch(body) });
    await expect(
      installContainerRuntime(deps, pinnedFor(body, "https://example.test/runtime.pkg")),
    ).rejects.toBeInstanceOf(DownloadError);
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["/usr/sbin/pkgutil", "--check-signature"],
    ]);
    expect((await readdir(dir)).filter((entry) => entry.startsWith("container-"))).toEqual([]);
  });

  it("reuses a completely unpacked version without downloading again", async () => {
    await mkdir(path.join(dir, "postgres-16.15.0"), { recursive: true });
    await writeFile(path.join(dir, "postgres-16.15.0", ".complete"), "");
    const { deps } = runtimeDeps(async () => fail());
    await expect(installPostgres(deps)).resolves.toBe(path.join(dir, "postgres-16.15.0"));
  });

  it("accepts only the publisher's notarized signature", () => {
    expect(verifyRuntimeSignature(SIGNED)).toBe(true);
    expect(
      verifyRuntimeSignature(
        SIGNED.replace("Notarization: trusted by the Apple notary service", ""),
      ),
    ).toBe(false);
    expect(verifyRuntimeSignature("Status: no signature")).toBe(false);
  });
});

describe("resolveContainerRuntime", () => {
  const ourCli = () => path.join(dir, "container-1.7.1", "bin", "container");
  const theirRoot = "/usr/local/";
  const status = (installRoot: string, version = "1.7.1", state = "running") =>
    JSON.stringify({ status: state, server: { version }, paths: { installRoot } });

  function fakeRuntime(input: {
    running?: { root: string; version?: string };
    launchdRoot?: string;
    userVersion?: string;
  }) {
    const calls: string[][] = [];
    const installed = new Set<string>();
    if (input.userVersion) installed.add(USER_CONTAINER_CLI);
    const run: RunDocker = async (binary, args) => {
      calls.push([binary, ...args]);
      if (binary === "/bin/launchctl") {
        return input.launchdRoot
          ? ok(`\tenvironment = {\n\t\tCONTAINER_INSTALL_ROOT => ${input.launchdRoot}\n\t}`)
          : fail(113);
      }
      if (args.join(" ") === "system status --format json") {
        return input.running
          ? ok(status(input.running.root, input.running.version))
          : ok(status("", "1.7.1", "unregistered"));
      }
      if (args[0] === "--version")
        return ok(`container CLI version ${input.userVersion} (build: release)`);
      return ok();
    };
    const exists = (file: string) =>
      installed.has(file) ||
      (input.running !== undefined && file === path.join(input.running.root, "bin", "container")) ||
      (input.launchdRoot !== undefined &&
        file === path.join(input.launchdRoot, "bin", "container"));
    return { calls, installed, run, exists };
  }

  it("uses a system someone else already runs without downloading anything", async () => {
    const fake = fakeRuntime({
      running: { root: "/opt/elsewhere" },
      launchdRoot: "/opt/elsewhere",
    });
    const { deps } = runtimeDeps(fake.run, { exists: fake.exists });
    const install = async () => {
      throw new Error("must not download");
    };
    await expect(resolveContainerRuntime(deps, install)).resolves.toEqual({
      cli: "/opt/elsewhere/bin/container",
      ours: false,
    });
    expect(fake.calls.some((call) => call.includes("start") || call.includes("stop"))).toBe(false);
  });

  it("starts the person's own install with its own defaults when nothing runs", async () => {
    const fake = fakeRuntime({ userVersion: "1.7.0" });
    const { deps } = runtimeDeps(fake.run, { exists: fake.exists });
    await expect(resolveContainerRuntime(deps, async () => ourCli())).resolves.toEqual({
      cli: USER_CONTAINER_CLI,
      ours: false,
    });
    expect(fake.calls.at(-1)).toEqual([
      USER_CONTAINER_CLI,
      "system",
      "start",
      "--enable-kernel-install",
      "--timeout",
      "120",
    ]);
  });

  it("ignores an install that is too old and starts our own copy in the app's folders", async () => {
    const fake = fakeRuntime({ userVersion: "1.6.0" });
    const { deps } = runtimeDeps(fake.run, { exists: fake.exists });
    await expect(resolveContainerRuntime(deps, async () => ourCli())).resolves.toEqual({
      cli: ourCli(),
      ours: true,
    });
    expect(fake.calls.at(-1)).toEqual([
      ourCli(),
      "system",
      "start",
      "--enable-kernel-install",
      "--timeout",
      "120",
      "--install-root",
      path.join(dir, "container-1.7.1"),
      "--app-root",
      path.join(dir, "vm"),
      "--log-root",
      path.join(dir, "vm-logs"),
    ]);
  });

  it("keeps using our running copy while the person has none", async () => {
    const root = path.join(dir, "container-1.7.1");
    const fake = fakeRuntime({ running: { root }, launchdRoot: root });
    const { deps } = runtimeDeps(fake.run, { exists: fake.exists });
    await expect(resolveContainerRuntime(deps, async () => ourCli())).resolves.toEqual({
      cli: ourCli(),
      ours: true,
    });
    expect(fake.calls.some((call) => call.includes("stop"))).toBe(false);
  });

  it("hands over from our copy to the person's install once they have one", async () => {
    const root = path.join(dir, "container-1.7.1");
    const fake = fakeRuntime({ running: { root }, launchdRoot: root, userVersion: "1.8.0" });
    const { deps } = runtimeDeps(fake.run, { exists: fake.exists });
    await expect(resolveContainerRuntime(deps, async () => ourCli())).resolves.toEqual({
      cli: USER_CONTAINER_CLI,
      ours: false,
    });
    const lifecycle = fake.calls.filter((call) => call[1] === "system" && call[2] !== "status");
    expect(lifecycle.map((call) => [call[0], call[2]])).toEqual([
      [ourCli(), "stop"],
      [USER_CONTAINER_CLI, "start"],
    ]);
  });

  it("never stops a running system that is not ours", async () => {
    const fake = fakeRuntime({
      running: { root: theirRoot, version: "1.7.1" },
      userVersion: "1.7.1",
    });
    const { deps } = runtimeDeps(fake.run, { exists: fake.exists });
    await resolveContainerRuntime(deps, async () => ourCli());
    expect(fake.calls.some((call) => call.includes("stop") || call.includes("start"))).toBe(false);
  });

  it("treats a running system older than the minimum as not running", async () => {
    const fake = fakeRuntime({
      running: { root: "/opt/old", version: "1.6.2" },
      launchdRoot: "/opt/old",
    });
    const { deps } = runtimeDeps(fake.run, { exists: fake.exists });
    await expect(resolveContainerRuntime(deps, async () => ourCli())).resolves.toEqual({
      cli: ourCli(),
      ours: true,
    });
  });
});

describe("readServerBundle", () => {
  const descriptor = {
    url: "https://github.com/elie222/rakazo/releases/download/v1.0.0/rakazo-server-darwin-arm64-1.0.0.tar.xz",
    sha256: "a".repeat(64),
    size: 100,
    version: "1.0.0",
  };

  it("reads a release build's descriptor", async () => {
    await writeFile(path.join(dir, "server-bundle.json"), JSON.stringify(descriptor));
    await expect(readServerBundle({ resourcesPath: dir, packaged: true })).resolves.toEqual({
      version: "1.0.0",
      download: { url: descriptor.url, sha256: descriptor.sha256, size: 100 },
    });
  });

  it.each([
    ["plain http", { url: "http://example.test/bundle.tar.xz" }],
    ["a short hash", { sha256: "abc" }],
    ["a path in the version", { version: "../1.0.0" }],
  ])("refuses %s", async (_, change) => {
    await writeFile(
      path.join(dir, "server-bundle.json"),
      JSON.stringify({ ...descriptor, ...change }),
    );
    await expect(readServerBundle({ resourcesPath: dir, packaged: true })).resolves.toBeNull();
  });

  it("has none without a descriptor, and honours a local archive only when unpackaged", async () => {
    const archive = path.join(dir, "local.tar.xz");
    await writeFile(archive, "x");
    await expect(
      readServerBundle({ resourcesPath: dir, packaged: true, override: archive }),
    ).resolves.toBeNull();
    const local = await readServerBundle({
      resourcesPath: dir,
      packaged: false,
      override: archive,
    });
    expect(local?.file).toBe(archive);
    expect(local?.version).toMatch(/^local-1-\d+$/);
  });
});

describe("pruneRuntimes", () => {
  it("keeps only the versions in use", async () => {
    for (const entry of [
      "postgres-16.15.0",
      "postgres-16.4.0",
      "server-1.0.0",
      ".server-x.tmp",
      "downloads",
    ]) {
      await mkdir(path.join(dir, entry));
    }
    await pruneRuntimes(dir, ["postgres-16.15.0", "server-1.0.0"]);
    expect((await readdir(dir)).sort()).toEqual(["postgres-16.15.0", "server-1.0.0"]);
  });
});
