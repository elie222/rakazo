// What This computer runs on an Apple silicon Mac without Docker, fetched only when it is chosen:
// a database server, the Rakazo server bundle and, unless the person already runs one, the
// computer runtime. Every download is pinned by size and SHA-256 and checked before it is unpacked.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RunDocker } from "./docker-cli.js";

/** Darwin 25 is macOS 26, the first release whose virtualization the computer runtime supports. */
const MIN_DARWIN_MAJOR = 25;

export function nativeStackEligible(input: {
  platform: string;
  arch: string;
  release: string;
}): boolean {
  const major = Number.parseInt(input.release, 10);
  return input.platform === "darwin" && input.arch === "arm64" && major >= MIN_DARWIN_MAJOR;
}

export interface PinnedDownload {
  url: string;
  sha256: string;
  size: number;
}

export const POSTGRES_VERSION = "16.15.0";
export const POSTGRES_DOWNLOAD: PinnedDownload = {
  url: `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-darwin-arm64v8/${POSTGRES_VERSION}/embedded-postgres-binaries-darwin-arm64v8-${POSTGRES_VERSION}.jar`,
  sha256: "65b953905f0a4d46030767a6b44a52360170d69a7985f1b02aa435f2f6256a83",
  size: 61_884_586,
};
const POSTGRES_ARCHIVE = "postgres-darwin-arm_64.txz";

export const CONTAINER_RUNTIME_VERSION = "1.7.1";
export const CONTAINER_RUNTIME_DOWNLOAD: PinnedDownload = {
  url: `https://github.com/apple/container/releases/download/${CONTAINER_RUNTIME_VERSION}/container-${CONTAINER_RUNTIME_VERSION}-installer-signed.pkg`,
  sha256: "b6739caf3d47ca53a78f1a7edf32521420a75c7941838c3cefa75f30b80f5a97",
  size: 169_630_704,
};
const CONTAINER_RUNTIME_SIGNER =
  "Developer ID Installer: Apple Inc. - Containerization (UPBK2H6LZM)";
/** What the computers need; the experimental cluster and image build plugins are left out. */
const CONTAINER_RUNTIME_PLUGINS = [
  "container-runtime-linux",
  "container-network-vmnet",
  "container-core-images",
  "machine-apiserver",
];
export const MIN_CONTAINER_RUNTIME = "1.7.0";
export const USER_CONTAINER_CLI = "/usr/local/bin/container";
const CONTAINER_API_LABEL = "com.apple.container.apiserver";

export interface ServerBundle {
  version: string;
  /** Release builds download and verify this; a development override names a local file. */
  download?: PinnedDownload;
  file?: string;
}

export const SERVER_BUNDLE_FILE = "server-bundle.json";

/**
 * Release builds for Apple silicon name the server bundle in their resources; others have none.
 * An unpackaged build may point `override` at a locally built archive instead.
 */
export async function readServerBundle(input: {
  resourcesPath: string;
  packaged: boolean;
  override?: string;
}): Promise<ServerBundle | null> {
  const override = input.override?.trim();
  if (!input.packaged && override) {
    const info = await stat(override).catch(() => null);
    return info?.isFile()
      ? { version: `local-${info.size}-${Math.trunc(info.mtimeMs)}`, file: path.resolve(override) }
      : null;
  }
  const raw = await readFile(path.join(input.resourcesPath, SERVER_BUNDLE_FILE), "utf8").catch(
    () => null,
  );
  if (raw === null) return null;
  try {
    const { url, sha256, size, version } = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof url === "string" &&
      url.startsWith("https://") &&
      typeof sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(sha256) &&
      Number.isSafeInteger(size) &&
      typeof version === "string" &&
      /^[\w.-]+$/.test(version)
    ) {
      return { version, download: { url, sha256, size: size as number } };
    }
  } catch {
    // An unreadable descriptor means no bundle, like a build that has none.
  }
  return null;
}

/** Marks a fully unpacked runtime directory; one without it is removed and unpacked again. */
const COMPLETE_MARKER = ".complete";
const RUNTIME_TIMEOUT_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 30_000;
const SYSTEM_START_TIMEOUT_S = 120;

/** The download itself failed or did not match its pin; retrying (or the network) fixes it. */
export class DownloadError extends Error {}

/** A system the app did not start is running a version computers cannot use. */
export class RuntimeTooOldError extends Error {}

export type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface RuntimeDeps {
  /** `<stack>/runtime`: one directory per pinned version, plus `downloads/` while fetching. */
  dir: string;
  run: RunDocker;
  fetch: Fetch;
  env: Record<string, string>;
  signal: AbortSignal;
  onBytes: (name: string, bytes: number) => void;
  onLine: (line: string) => void;
}

/**
 * Streams a pinned download to a private temporary file, hashing as it goes, and renames it into
 * place only when size and hash match. A failed or interrupted download leaves nothing behind.
 */
export async function downloadVerified(
  deps: Pick<RuntimeDeps, "fetch" | "signal" | "onBytes">,
  name: string,
  pinned: PinnedDownload,
  destination: string,
): Promise<void> {
  const partial = `${destination}.${randomUUID()}.partial`;
  try {
    const response = await deps
      .fetch(pinned.url, { signal: deps.signal })
      .catch((error: unknown) => {
        throw new DownloadError(`Download of ${name} failed: ${(error as Error).message}`);
      });
    if (!response.ok || response.body === null) {
      throw new DownloadError(`Download of ${name} answered HTTP ${response.status}`);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const counted = Readable.fromWeb(response.body as never).map((chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > pinned.size) throw new DownloadError(`${name} is larger than expected`);
      hash.update(chunk);
      deps.onBytes(name, bytes);
      return chunk;
    });
    await pipeline(counted, createWriteStream(partial, { mode: 0o600 }), {
      signal: deps.signal,
    }).catch((error: unknown) => {
      if (error instanceof DownloadError || deps.signal.aborted) throw error;
      throw new DownloadError(`Download of ${name} failed: ${(error as Error).message}`);
    });
    if (bytes !== pinned.size || hash.digest("hex") !== pinned.sha256) {
      throw new DownloadError(`${name} does not match its pinned checksum`);
    }
    await rename(partial, destination);
  } finally {
    await rm(partial, { force: true });
  }
}

async function runChecked(deps: RuntimeDeps, binary: string, args: string[], timeoutMs: number) {
  const result = await deps.run(binary, args, {
    cwd: deps.dir,
    env: deps.env,
    timeoutMs,
    signal: deps.signal,
  });
  if (result.code !== 0) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-3).join("\n");
    throw new Error(
      `${path.basename(binary)} ${args.slice(0, 2).join(" ")} exited with code ${result.code}\n${detail}`,
    );
  }
  return result;
}

/**
 * Downloads (or reuses) one pinned version: fetch into `downloads/`, unpack into a scratch
 * directory, and rename that into `<dir>/<name>` only once it is complete.
 */
async function installVersion(
  deps: RuntimeDeps,
  name: string,
  source: PinnedDownload | { file: string },
  unpack: (archive: string, into: string) => Promise<void>,
): Promise<string> {
  const target = path.join(deps.dir, name);
  if ((await readFile(path.join(target, COMPLETE_MARKER), "utf8").catch(() => null)) !== null) {
    return target;
  }
  await mkdir(path.join(deps.dir, "downloads"), { recursive: true, mode: 0o700 });
  const scratch = path.join(deps.dir, `.${name}.${randomUUID()}`);
  let archive: string;
  let downloaded = false;
  if ("file" in source) {
    archive = source.file;
  } else {
    archive = path.join(
      deps.dir,
      "downloads",
      `${randomUUID()}-${path.basename(new URL(source.url).pathname)}`,
    );
    deps.onLine(`Downloading ${name}`);
    await downloadVerified(deps, name, source, archive);
    downloaded = true;
  }
  try {
    await mkdir(scratch, { mode: 0o700 });
    deps.onLine(`Unpacking ${name}`);
    await unpack(archive, scratch);
    await writeFile(path.join(scratch, COMPLETE_MARKER), "");
    await rm(target, { recursive: true, force: true });
    await rename(scratch, target);
    return target;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    if (downloaded) await rm(archive, { force: true });
  }
}

/** Returns the directory holding `bin/initdb`, `bin/postgres` and their libraries. */
export function installPostgres(deps: RuntimeDeps): Promise<string> {
  return installVersion(
    deps,
    `postgres-${POSTGRES_VERSION}`,
    POSTGRES_DOWNLOAD,
    async (jar, into) => {
      await runChecked(
        deps,
        "/usr/bin/unzip",
        ["-q", "-o", jar, POSTGRES_ARCHIVE, "-d", into],
        RUNTIME_TIMEOUT_MS,
      );
      const archive = path.join(into, POSTGRES_ARCHIVE);
      await runChecked(deps, "/usr/bin/tar", ["-xJf", archive, "-C", into], RUNTIME_TIMEOUT_MS);
      await rm(archive);
    },
  );
}

export interface ServerManifest {
  version: string;
  entrypoints: Record<"api" | "worker" | "web" | "migrate", string>;
}

/** Returns the unpacked `rakazo-server/` directory and its manifest. */
export async function installServerBundle(
  deps: RuntimeDeps,
  bundle: ServerBundle,
): Promise<{ dir: string; manifest: ServerManifest }> {
  const source = bundle.download ?? (bundle.file ? { file: bundle.file } : null);
  if (source === null) throw new Error("No server bundle is configured");
  const root = await installVersion(deps, `server-${bundle.version}`, source, (archive, into) =>
    runChecked(deps, "/usr/bin/tar", ["-xJf", archive, "-C", into], RUNTIME_TIMEOUT_MS).then(
      () => undefined,
    ),
  );
  const dir = path.join(root, "rakazo-server");
  const manifest = JSON.parse(
    await readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as ServerManifest;
  for (const entry of ["api", "worker", "web", "migrate"] as const) {
    const file = manifest.entrypoints?.[entry];
    const resolved = typeof file === "string" ? path.resolve(dir, file) : "";
    if (!resolved.startsWith(`${dir}${path.sep}`)) {
      throw new DownloadError(`The server bundle names no ${entry} entrypoint inside itself`);
    }
  }
  return { dir, manifest };
}

/** Checks the installer's Developer ID signature and notarization before anything is unpacked. */
export function verifyRuntimeSignature(output: string): boolean {
  const lines = output.split("\n").map((line) => line.trim());
  return (
    lines.includes("Status: signed by a developer certificate issued by Apple for distribution") &&
    lines.includes("Notarization: trusted by the Apple notary service") &&
    lines.some((line) => line === `1. ${CONTAINER_RUNTIME_SIGNER}`)
  );
}

/** Returns the `container` CLI of our own copy of the computer runtime. */
export async function installContainerRuntime(
  deps: RuntimeDeps,
  pinned = CONTAINER_RUNTIME_DOWNLOAD,
): Promise<string> {
  const root = await installVersion(
    deps,
    `container-${CONTAINER_RUNTIME_VERSION}`,
    pinned,
    async (pkg, into) => {
      const signature = await deps.run("/usr/sbin/pkgutil", ["--check-signature", pkg], {
        cwd: deps.dir,
        env: deps.env,
        timeoutMs: CLI_TIMEOUT_MS,
        signal: deps.signal,
      });
      if (signature.code !== 0 || !verifyRuntimeSignature(signature.stdout)) {
        throw new DownloadError("The computer runtime installer is not signed by its publisher");
      }
      const expanded = path.join(into, "expanded");
      await runChecked(
        deps,
        "/usr/sbin/pkgutil",
        ["--expand-full", pkg, expanded],
        RUNTIME_TIMEOUT_MS,
      );
      const payload = path.join(expanded, "Payload");
      for (const binary of ["container", "container-apiserver"]) {
        await mkdir(path.join(into, "bin"), { recursive: true });
        await rename(path.join(payload, "bin", binary), path.join(into, "bin", binary));
      }
      const plugins = path.join("libexec", "container", "plugins");
      await mkdir(path.join(into, plugins), { recursive: true });
      for (const plugin of CONTAINER_RUNTIME_PLUGINS) {
        await rename(path.join(payload, plugins, plugin), path.join(into, plugins, plugin));
      }
      await rm(expanded, { recursive: true, force: true });
    },
  );
  return path.join(root, "bin", "container");
}

/** Numeric comparison of dotted versions; anything unparsable counts as too old. */
export function versionAtLeast(version: string | undefined, minimum: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  if (!version || !/^\d+\.\d+(\.\d+)?/.test(version)) return false;
  const have = parse(version);
  const want = parse(minimum);
  for (let index = 0; index < want.length; index += 1) {
    const difference = (have[index] ?? 0) - (want[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export interface ContainerRuntime {
  cli: string;
  /** True when the app started (and so may stop) this system from its own copy. */
  ours: boolean;
}

export interface ResolveRuntimeDeps extends RuntimeDeps {
  uid: number;
  exists: (file: string) => boolean;
  /** Where the app's own system keeps its images, VMs and logs. */
  appRoot: string;
  logRoot: string;
}

interface RunningSystem {
  cli: string;
  installRoot: string;
  version: string | undefined;
}

async function runningSystem(
  deps: ResolveRuntimeDeps,
  ourCli: string,
): Promise<RunningSystem | null> {
  const launchd = await deps.run(
    "/bin/launchctl",
    ["print", `gui/${deps.uid}/${CONTAINER_API_LABEL}`],
    { cwd: deps.dir, env: deps.env, timeoutMs: CLI_TIMEOUT_MS, signal: deps.signal },
  );
  const registeredRoot =
    launchd.code === 0
      ? /CONTAINER_INSTALL_ROOT => (.+)$/m.exec(launchd.stdout)?.[1]?.trim()
      : undefined;
  const candidates = [
    USER_CONTAINER_CLI,
    ...(registeredRoot ? [path.join(registeredRoot, "bin", "container")] : []),
    ourCli,
  ].filter((cli, index, all) => all.indexOf(cli) === index && deps.exists(cli));
  for (const cli of candidates) {
    const status = await deps.run(cli, ["system", "status", "--format", "json"], {
      cwd: deps.dir,
      env: deps.env,
      timeoutMs: CLI_TIMEOUT_MS,
      signal: deps.signal,
    });
    let parsed: {
      status?: string;
      server?: { version?: string };
      paths?: { installRoot?: string };
    };
    try {
      parsed = JSON.parse(status.stdout);
    } catch {
      continue;
    }
    // Every client asks the same launchd service, so the first answer is the answer.
    if (parsed.status !== "running") return null;
    const installRoot = parsed.paths?.installRoot;
    const ownCli = installRoot ? path.join(installRoot, "bin", "container") : "";
    return {
      cli: installRoot && deps.exists(ownCli) ? ownCli : cli,
      installRoot: installRoot ?? "",
      version: parsed.server?.version,
    };
  }
  return null;
}

async function cliVersion(deps: ResolveRuntimeDeps, cli: string): Promise<string | undefined> {
  if (!deps.exists(cli)) return undefined;
  const result = await deps.run(cli, ["--version"], {
    cwd: deps.dir,
    env: deps.env,
    timeoutMs: CLI_TIMEOUT_MS,
    signal: deps.signal,
  });
  return result.code === 0 ? /version (\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] : undefined;
}

/** The runtime reports its root resolved (`/private/var/…`), which a plain path may not be. */
async function isInside(dir: string, file: string): Promise<boolean> {
  const inside = (root: string, target: string) =>
    target === root || target.startsWith(`${root}${path.sep}`);
  const real = (value: string) => realpath(value).catch(() => path.resolve(value));
  return inside(path.resolve(dir), path.resolve(file)) || inside(await real(dir), await real(file));
}

/**
 * Only one computer runtime can run per macOS session. Use the one already running, else the
 * person's own install, else our copy (downloaded on first use). A system we started gives way to
 * the person's own install once they have one, and an outdated one is replaced; a system we did
 * not start is never stopped, and one too old to use fails the start instead.
 */
export async function resolveContainerRuntime(
  deps: ResolveRuntimeDeps,
  install: () => Promise<string> = () => installContainerRuntime(deps),
): Promise<ContainerRuntime> {
  const ourCli = path.join(deps.dir, `container-${CONTAINER_RUNTIME_VERSION}`, "bin", "container");
  const running = await runningSystem(deps, ourCli);
  const userVersion = await cliVersion(deps, USER_CONTAINER_CLI);
  const userUsable = versionAtLeast(userVersion, MIN_CONTAINER_RUNTIME);
  if (running) {
    const ours = running.installRoot !== "" && (await isInside(deps.dir, running.installRoot));
    const current = versionAtLeast(running.version, MIN_CONTAINER_RUNTIME);
    if (!ours && !current)
      throw new RuntimeTooOldError(
        `The running computer runtime is ${running.version ?? "of an unknown version"}; computers need ${MIN_CONTAINER_RUNTIME} or newer`,
      );
    if (current && (!ours || !userUsable)) return { cli: running.cli, ours };
    deps.onLine(
      current
        ? "Handing computers over to the installed runtime"
        : "Replacing an outdated computer runtime",
    );
    await runChecked(deps, running.cli, ["system", "stop"], RUNTIME_TIMEOUT_MS);
  }
  const start = [
    "system",
    "start",
    "--enable-kernel-install",
    "--timeout",
    String(SYSTEM_START_TIMEOUT_S),
  ];
  if (userUsable) {
    deps.onLine("Starting the computer runtime");
    await runChecked(deps, USER_CONTAINER_CLI, start, RUNTIME_TIMEOUT_MS);
    return { cli: USER_CONTAINER_CLI, ours: false };
  }
  const cli = await install();
  deps.onLine("Starting the computer runtime");
  await runChecked(
    deps,
    cli,
    [
      ...start,
      "--install-root",
      path.dirname(path.dirname(cli)),
      "--app-root",
      deps.appRoot,
      "--log-root",
      deps.logRoot,
    ],
    RUNTIME_TIMEOUT_MS,
  );
  return { cli, ours: true };
}

/** Removes unpacked versions nothing uses any more, and leftovers of interrupted unpacks. */
export async function pruneRuntimes(dir: string, keep: string[]): Promise<void> {
  const kept = new Set(keep.map((entry) => path.basename(entry)));
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    if (!kept.has(entry)) await rm(path.join(dir, entry), { recursive: true, force: true });
  }
}
