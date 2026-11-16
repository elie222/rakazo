import { randomUUID } from "node:crypto";
import type { UnreferencedMachine, UnreferencedMachineRecords } from "@rakazo/adapter-kit";
import {
  SandboxProviderAccountError,
  SandboxRateLimitError,
  SandboxSizeUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import type { ComputerSize } from "@rakazo/contracts";
import { COMPUTER_SIZE_SPECS } from "@rakazo/contracts";
import { pollUntil, retry, withAbort } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import {
  BASE_SNAPSHOT_BUILD_TIMEOUT_MS,
  BaseSnapshotCache,
  computerSnapshotName,
} from "./computer-base-snapshot.js";
import { shellQuote } from "./computer-support.js";
import type { Kosa8Api, Kosa8ExecResult } from "./kosa8-api.js";
import { Kosa8ApiError, nativeKosa8Api } from "./kosa8-api.js";
import {
  INSTALL_LINUX_BROWSER,
  PREPARE_LINUX_DESKTOP,
  VERIFY_LINUX_DESKTOP,
} from "./linux-desktop.js";
import type {
  CommandResult,
  CommandStartOpts,
  RemoteDesktop,
  RemoteDesktopSdk,
} from "./remote-desktop-sandbox.js";
import { RemoteDesktopSandboxProvider } from "./remote-desktop-sandbox.js";
import { deleteUnreferencedMachine, recordUnreferencedMachine } from "./sandbox-cleanup.js";
import {
  isSandboxGoneError,
  isSandboxUnsafeStopError,
  SandboxUnsafeStopError,
  sandboxNotFoundError,
} from "./sandbox-errors.js";

/** kosa8's Ubuntu 24.04 image, one warm pool per size: `universal-4x8` and so on. */
export const KOSA8_COMPUTER_TEMPLATE = "universal";
/** The desktop gateway serves every screen and terminal on this port. */
const SCREEN_PORT = 6100;
/** kosa8's file API reaches /workspace only, so the runtime's /home/user lives there. */
const HOME_IN_WORKSPACE = "/workspace/user";
const LINK_HOME = `mkdir -p ${HOME_IN_WORKSPACE} && { [ -e /home/user ] || ln -s ${HOME_IN_WORKSPACE} /home/user; }`;
/** Where files bound for paths outside /workspace pass through. */
const TRANSFER_DIR = "/workspace/.rakazo-transfer";
/** kosa8 takes each argument up to 8 KiB; a quoted command longer than this runs from a file. */
const MAX_INLINE_COMMAND_BYTES = 8_000;
/** Parallel file transfers per batch. */
const FILE_CONCURRENCY = 8;
/** A command without a deadline of its own still ends: a day, kosa8's longest exec. */
const LONGEST_COMMAND_S = 86_400;
/** kosa8 sleeps a computer Rakazo has forgotten; Rakazo normally stops it first. */
const SLEEP_AFTER_S = 1_800;
/** Desktop tools and Chrome install from apt the first time, before the snapshot exists. */
const SETUP_TIMEOUT_MS = 15 * 60_000;
/** Every process a command started carries this, so a cancelled command can be ended. */
const RUN_MARKER = "RAKAZO_KOSA8_RUN";

/**
 * Ends every process of a run, given `m` as its marker: each process whose environment carries
 * the marker, and every descendant of one, since a command may unset the marker in its children.
 * It looks again after each signal, so a process forked meanwhile is caught too, and exits 3 when
 * any survive KILL.
 */
const END_RUN = `scan() {
  pids=" "
  local p line rest state grew=1
  local -A parent=()
  cd /proc || return 0
  for p in [0-9]*; do
    read -r line < "$p/stat" 2>/dev/null || continue
    rest=\${line##*) }
    state=\${rest%% *}; rest=\${rest#* }
    [ "$state" = Z ] && continue
    parent[$p]=\${rest%% *}
    grep -qzxF -- "$m" "$p/environ" 2>/dev/null && pids="$pids$p "
  done
  [ "$pids" = " " ] && { pids=""; return 0; }
  while [ -n "$grew" ]; do
    grew=""
    for p in "\${!parent[@]}"; do
      case "$pids" in *" $p "*) continue ;; esac
      case "$pids" in *" \${parent[$p]} "*) pids="$pids$p "; grew=1 ;; esac
    done
  done
}
scan; [ -n "$pids" ] || exit 0
kill -TERM $pids 2>/dev/null
for i in 1 2 3 4 5 6 7 8; do sleep 0.25; scan; [ -n "$pids" ] || exit 0; done
for i in 1 2 3; do kill -KILL $pids 2>/dev/null; sleep 0.2; scan; [ -n "$pids" ] || exit 0; done
echo "processes survived KILL:$pids" >&2
exit 3`;

const PREPARE_KOSA8_DESKTOP = [PREPARE_LINUX_DESKTOP, INSTALL_LINUX_BROWSER].join("\n");

/** What a computer snapshot captures, in order: the home link, the desktop, then a check. */
export const KOSA8_COMPUTER_SETUP = [
  LINK_HOME,
  PREPARE_LINUX_DESKTOP,
  INSTALL_LINUX_BROWSER,
  VERIFY_LINUX_DESKTOP,
] as const;

/** A sandbox made from a snapshot keeps the snapshot's size, so each size has its own. */
export function kosa8ComputerSnapshot(size: ComputerSize): string {
  return `${computerSnapshotName(KOSA8_COMPUTER_SETUP)}-${size}`;
}

/** kosa8 owns the microVM lifecycle; the shared Linux runtime owns each bot's desktop. */
export class Kosa8SandboxProvider extends RemoteDesktopSandboxProvider {
  private readonly kill: (id: string) => Promise<boolean>;

  constructor(
    options: {
      apiKey: string;
      apiUrl?: string;
      onUnsafeStop?: (providerRef: string) => Promise<void>;
      unreferencedMachines?: UnreferencedMachineRecords;
    },
    sdk?: RemoteDesktopSdk,
  ) {
    const kosa8 =
      sdk ??
      kosa8Sdk(
        nativeKosa8Api(options.apiKey, options.apiUrl),
        options.onUnsafeStop,
        options.unreferencedMachines,
      );
    super({
      id: "kosa8",
      label: "kosa8",
      apiKey: options.apiKey,
      template: KOSA8_COMPUTER_TEMPLATE,
      sdk: kosa8,
      // Commands past their deadline come back as exit 124, never as an error.
      isTimeoutError: () => false,
    });
    this.kill = (id) => kosa8.kill(id, { apiKey: options.apiKey });
  }

  /** Deleting by id never wakes a sleeping computer; false means it was already gone. */
  async deleteMachine(machine: UnreferencedMachine, signal: AbortSignal): Promise<void> {
    await withAbort(this.kill(machine.machineId), signal);
  }
}

export function kosa8Sdk(
  api: Kosa8Api,
  onUnsafeStop?: (providerRef: string) => Promise<void>,
  machines?: UnreferencedMachineRecords,
): RemoteDesktopSdk {
  const state = async (id: string) => {
    try {
      return (await api.get(id)).state;
    } catch (error) {
      throw translate(error, id);
    }
  };
  // A sleeping kosa8 computer keeps a command it could not end in memory, so other instances are
  // fenced off before it sleeps, or a later wake would carry the command on.
  const safetySleep = async (id: string) => {
    let fenceError: unknown;
    try {
      await onUnsafeStop?.(id);
    } catch (error) {
      fenceError = error;
    }
    try {
      await api.sleep(id);
    } catch (error) {
      if (!isSandboxGoneError(translate(error, id))) throw error;
    }
    if (fenceError) throw fenceError;
  };
  const snapshots = new Map<ComputerSize, BaseSnapshotCache>();
  const snapshotIds = new Map<string, string>();
  /** When a snapshot was first seen saving; one saving longer than a build is abandoned. */
  const savingSince = new Map<string, number>();
  const baseSnapshot = (size: ComputerSize) => {
    let cache = snapshots.get(size);
    if (!cache) {
      cache = new BaseSnapshotCache({
        provider: "kosa8",
        name: kosa8ComputerSnapshot(size),
        build: () => buildKosa8ComputerSnapshot(api, size, machines),
        warnMissingOnce: true,
      });
      snapshots.set(size, cache);
    }
    return cache.current(AbortSignal.timeout(30_000), async () => {
      const name = kosa8ComputerSnapshot(size);
      const found = newest(await api.snapshots(), name);
      if (found?.state === "ready") {
        snapshotIds.set(name, found.id);
        savingSince.delete(name);
        return "ready";
      }
      if (found?.state !== "creating") return "absent";
      const since = savingSince.get(name) ?? Date.now();
      savingSince.set(name, since);
      return Date.now() - since > BASE_SNAPSHOT_BUILD_TIMEOUT_MS ? "absent" : "saving";
    });
  };
  /** A build in this process saves the snapshot without its id, so a missing id is looked up. */
  const snapshotId = async (name: string): Promise<string | undefined> => {
    const known = snapshotIds.get(name);
    if (known) return known;
    const snapshots = await bestEffort("look up the kosa8 computer snapshot", api.snapshots());
    const found = snapshots && newest(snapshots, name);
    if (found?.state !== "ready") return undefined;
    snapshotIds.set(name, found.id);
    return found.id;
  };
  const open = (id: string, setup: boolean, fresh = false) =>
    openDesktop(api, id, setup, fresh, () => safetySleep(id));
  return {
    create: async (template, options, size = "standard") => {
      const name = await baseSnapshot(size);
      const snapshot = name ? await snapshotId(name) : undefined;
      const request = {
        name: "rakazo-computer",
        labels: { ...options.metadata },
        sleepAfterS: SLEEP_AFTER_S,
      };
      let id: string;
      let fromSnapshot = false;
      try {
        if (snapshot) {
          try {
            id = (await api.create({ ...request, snapshot })).id;
            fromSnapshot = true;
          } catch (error) {
            if (!(error instanceof Kosa8ApiError) || ![404, 409].includes(error.status))
              throw error;
            if (name) snapshotIds.delete(name);
            snapshots.get(size)?.lost();
            id = (await api.create({ ...request, template: sizedTemplate(template, size) })).id;
          }
        } else {
          id = (await api.create({ ...request, template: sizedTemplate(template, size) })).id;
        }
      } catch (error) {
        throw translate(error, undefined, size !== "standard");
      }
      const created = { provider: "kosa8", machineId: id, homeKey: options.metadata.botId };
      await recordUnreferencedMachine(machines, created);
      try {
        return await open(id, true, !fromSnapshot);
      } catch (error) {
        // Nothing has the new computer's reference yet, so nothing else would delete it.
        await deleteUnreferencedMachine(machines, created, async (_signal, timeoutMs) =>
          api.delete(id, timeoutMs),
        );
        throw error;
      }
    },
    connect: async (id) => {
      const current = await state(id);
      if (current !== "running" && current !== "creating") {
        try {
          await api.wake(id);
        } catch (error) {
          throw translate(error, id);
        }
      }
      return open(id, true);
    },
    connectRunning: async (id) => {
      const current = await state(id);
      if (current !== "running") throw notRunning(current);
      return open(id, false);
    },
    isRunning: async (id) => (await state(id)) === "running",
    pause: async (id) => {
      let current: string;
      try {
        current = await state(id);
      } catch (error) {
        if (isSandboxGoneError(error)) return;
        throw error;
      }
      if (current !== "running" && current !== "creating") return;
      try {
        await api.sleep(id);
      } catch (error) {
        throw translate(error, id);
      }
    },
    kill: async (id) => {
      try {
        return await api.delete(id);
      } catch (error) {
        throw translate(error);
      }
    },
  };
}

/**
 * Builds the snapshot new computers of `size` start from: a fresh computer with the desktop tools
 * and Chrome installed and checked. The build computer is deleted afterwards.
 */
export async function buildKosa8ComputerSnapshot(
  api: Kosa8Api,
  size: ComputerSize,
  machines?: UnreferencedMachineRecords,
  signal: AbortSignal = AbortSignal.timeout(BASE_SNAPSHOT_BUILD_TIMEOUT_MS),
): Promise<{ name: string; built: boolean }> {
  const name = kosa8ComputerSnapshot(size);
  if (newest(await api.snapshots(), name)?.state === "ready") return { name, built: false };
  const { id } = await api.create({
    template: sizedTemplate(KOSA8_COMPUTER_TEMPLATE, size),
    name: `rakazo-snapshot-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    labels: { rakazo: "snapshot" },
    sleepAfterS: 0,
  });
  const machine = { provider: "kosa8", machineId: id };
  await recordUnreferencedMachine(machines, machine, BASE_SNAPSHOT_BUILD_TIMEOUT_MS);
  let saved: { id: string } | undefined;
  try {
    for (const command of KOSA8_COMPUTER_SETUP) {
      const result = await runCommand(api, id, command, { timeoutMs: SETUP_TIMEOUT_MS, signal });
      if (result.exitCode !== 0)
        throw new Error(`could not prepare the kosa8 computer snapshot: ${failure(result)}`);
    }
    saved = await api.snapshot(id, name);
    const savedId = saved.id;
    await pollUntil(
      async () => {
        const found = (await api.snapshots()).find((entry) => entry.id === savedId);
        if (!found || found.state === "error" || found.state === "deleted")
          throw new Error(`kosa8 could not save snapshot ${name}`);
        return found.state === "ready";
      },
      { intervalMs: 2_000, timeoutMs: BASE_SNAPSHOT_BUILD_TIMEOUT_MS, signal, waitingFor: name },
    );
    return { name, built: true };
  } catch (error) {
    // A save that stalled or failed would otherwise read as one still saving, holding off builds.
    if (saved) await bestEffort("delete an unsaved kosa8 snapshot", api.deleteSnapshot(saved.id));
    throw error;
  } finally {
    await deleteUnreferencedMachine(machines, machine, async (_signal, timeoutMs) =>
      api.delete(id, timeoutMs),
    );
  }
}

/** Links the runtime's home and publishes the desktop gateway; a fresh computer gets Chrome. */
async function openDesktop(
  api: Kosa8Api,
  id: string,
  setup: boolean,
  fresh: boolean,
  sleep: () => Promise<void>,
): Promise<RemoteDesktop> {
  if (setup) await checked(api, id, LINK_HOME, sleep);
  // Until the snapshot is saved, a computer from the pool installs the desktop and Chrome itself.
  if (fresh) await checked(api, id, PREPARE_KOSA8_DESKTOP, sleep, SETUP_TIMEOUT_MS);
  let host: string;
  try {
    host = (await api.publish(id, SCREEN_PORT)).host;
  } catch (error) {
    throw translate(error, id);
  }
  return kosa8Desktop(api, id, host, sleep);
}

export function kosa8Desktop(
  api: Kosa8Api,
  id: string,
  host: string,
  sleep: () => Promise<void>,
): RemoteDesktop {
  const run = (command: string, options: CommandStartOpts) =>
    runCommand(api, id, command, options, sleep);
  return {
    sandboxId: id,
    getHost: (port) => {
      if (port !== SCREEN_PORT)
        throw new Error(`kosa8 computer publishes port ${SCREEN_PORT} only`);
      return host;
    },
    // kosa8 has no lifetime deadline to move; this only proves the computer still runs.
    setTimeout: async () => {
      let current: string;
      try {
        current = (await api.get(id)).state;
      } catch (error) {
        const translated = translate(error, id);
        // box() drops this handle on any throw. A rate limit says nothing about the computer.
        if (translated instanceof SandboxRateLimitError) return;
        throw translated;
      }
      if (current !== "running") throw notRunning(current);
    },
    commands: { run: (command, options) => run(command, options) },
    files: {
      makeDir: async (path) => {
        await checked(api, id, `mkdir -p -- ${shellQuote(path)}`, sleep);
        return true;
      },
      list: async (path, options) => {
        const result = await run(
          `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%y %s %m %f\\0'`,
          { signal: options.signal },
        );
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cannot list ${path}`);
        return result.stdout
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const [kind, size, mode] = line.split(" ", 3);
            return {
              name: line.split(" ").slice(3).join(" "),
              type: kind === "f" ? "file" : kind === "d" ? "dir" : "other",
              size: Number(size),
              mode: Number.parseInt(mode ?? "0", 8),
            };
          });
      },
      getInfo: async (path, options) => {
        const result = await run(`stat -L -c '%s %a' -- ${shellQuote(path)}`, {
          signal: options.signal,
        });
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `no such file: ${path}`);
        const [size, mode] = result.stdout.trim().split(" ");
        return {
          name: path.split("/").at(-1) ?? path,
          type: "file",
          size: Number(size),
          mode: Number.parseInt(mode ?? "0", 8),
        };
      },
      read: async (path, options) => {
        options.signal?.throwIfAborted();
        const direct = inWorkspace(path);
        if (direct) return readFile(api, id, direct, options.signal);
        // Copied into the workspace first, since the file API reaches nothing outside it.
        const staged = `${TRANSFER_DIR}/${randomUUID()}`;
        try {
          await checked(
            api,
            id,
            `mkdir -p ${TRANSFER_DIR} && cp -- ${shellQuote(path)} ${shellQuote(staged)}`,
            sleep,
          );
          return await readFile(api, id, staged, options.signal);
        } finally {
          await checked(api, id, `rm -f -- ${shellQuote(staged)}`, sleep);
        }
      },
      write: async (files, options) => {
        for (let index = 0; index < files.length; index += FILE_CONCURRENCY) {
          await Promise.all(
            files.slice(index, index + FILE_CONCURRENCY).map(async (file) => {
              const data = new Uint8Array(file.data);
              const direct = inWorkspace(file.path);
              if (direct) return writeFile(api, id, direct, data, options.signal);
              const staged = `${TRANSFER_DIR}/${randomUUID()}`;
              try {
                await writeFile(api, id, staged, data, options.signal);
                await checked(
                  api,
                  id,
                  `mkdir -p -- "$(dirname -- ${shellQuote(file.path)})" && mv -f -- ${shellQuote(staged)} ${shellQuote(file.path)}`,
                  sleep,
                  undefined,
                  options.signal,
                );
              } catch (error) {
                // The staged copy may hold anything, saved logins included; it never outlives the write.
                await bestEffort(
                  "remove a staged kosa8 file",
                  checked(api, id, `rm -f -- ${shellQuote(staged)}`, sleep),
                );
                throw error;
              }
            }),
          );
        }
      },
    },
  };
}

/** The path the file API takes for `path`, or undefined when it is outside /workspace. */
function inWorkspace(path: string): string | undefined {
  if (path === "/home/user" || path.startsWith("/home/user/"))
    return `${HOME_IN_WORKSPACE}${path.slice("/home/user".length)}`;
  if (path.startsWith("/workspace/")) return path;
  return undefined;
}

async function readFile(api: Kosa8Api, id: string, path: string, signal?: AbortSignal) {
  try {
    return await api.readFile(id, path, signal);
  } catch (error) {
    throw translate(error);
  }
}

async function writeFile(
  api: Kosa8Api,
  id: string,
  path: string,
  data: Uint8Array,
  signal?: AbortSignal,
) {
  try {
    await api.writeFile(id, path, data, signal);
  } catch (error) {
    throw translate(error);
  }
}

async function checked(
  api: Kosa8Api,
  id: string,
  command: string,
  sleep: () => Promise<void>,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runCommand(api, id, command, { timeoutMs, signal }, sleep);
  signal?.throwIfAborted();
  if (result.exitCode !== 0) throw new Error(`kosa8 command failed: ${failure(result)}`);
}

const ABORTED: CommandResult = { exitCode: 130, stdout: "", stderr: "command aborted\n" };

/**
 * Runs under `timeout` with a marker in its environment, so the deadline, a cancel, or a lost
 * connection ends the command and everything it started. A non-zero exit, a deadline, or an abort
 * is a result; only transport failures throw.
 */
export async function runCommand(
  api: Kosa8Api,
  id: string,
  command: string,
  options: CommandStartOpts,
  sleep?: () => Promise<void>,
): Promise<CommandResult> {
  const { signal, timeoutMs, cwd, envs } = options;
  // Nothing was started, so there is no process to end.
  if (signal?.aborted) return ABORTED;
  const run = randomUUID();
  const seconds =
    timeoutMs === undefined ? LONGEST_COMMAND_S : Math.max(1, Math.ceil(timeoutMs / 1000));
  const script = cwd ? `cd -- ${shellQuote(cwd)} && ${command}` : command;
  const wrap = (body: string) => `exec timeout -k 5 ${seconds} bash -c ${shellQuote(body)}`;
  let wrapped = wrap(script);
  let file: string | undefined;
  // Quoting grows the script, so the limit applies to the argument kosa8 is sent.
  if (Buffer.byteLength(wrapped) > MAX_INLINE_COMMAND_BYTES) {
    file = `${TRANSFER_DIR}/${run}.sh`;
    try {
      await api.writeFile(id, file, new TextEncoder().encode(script), signal);
    } catch (error) {
      await removeScript(api, id, file);
      if (signal?.aborted) return ABORTED;
      throw translate(error, id);
    }
    wrapped = wrap(`status=0; bash ${file} || status=$?; rm -f -- ${file}; exit "$status"`);
  }
  const started = Date.now();
  let result: Kosa8ExecResult;
  try {
    result = await api.exec(id, wrapped, {
      env: { ...envs, [RUN_MARKER]: run },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) {
      await endRun(api, id, run, sleep, error);
      if (file) await removeScript(api, id, file);
      return ABORTED;
    }
    const translated = translate(error, id);
    if (isSandboxGoneError(translated) || translated instanceof SandboxRateLimitError)
      throw translated;
    // The command may still be running on a connection that dropped.
    await endRun(api, id, run, sleep, error);
    if (file) await removeScript(api, id, file);
    throw translated;
  }
  const timedOut =
    timeoutMs !== undefined &&
    (result.exitCode === 124 || result.exitCode === 137) &&
    Date.now() - started >= timeoutMs;
  if (timedOut) {
    // `timeout` ends its own process group; what the command moved out of it ends here.
    await endRun(api, id, run, sleep, new Error(`command timed out after ${timeoutMs} ms`));
    if (file) await removeScript(api, id, file);
    const message = `command timed out after ${timeoutMs} ms\n`;
    return { exitCode: 124, stdout: result.stdout, stderr: message, error: message };
  }
  return result;
}

/** A script file whose run was cut short; its own `rm` never ran. */
async function removeScript(api: Kosa8Api, id: string, file: string): Promise<void> {
  await bestEffort(
    "remove a kosa8 command script",
    api.exec(id, `rm -f -- ${shellQuote(file)}`, { env: {} }),
  );
}

/** Ends every process carrying the run's marker; puts the computer to sleep if it cannot. */
async function endRun(
  api: Kosa8Api,
  id: string,
  run: string,
  sleep: (() => Promise<void>) | undefined,
  cause: unknown,
): Promise<void> {
  const script = `m=${shellQuote(`${RUN_MARKER}=${run}`)}\n${END_RUN}`;
  try {
    await retry(
      async () => {
        const result = await api.exec(id, script, { env: {} });
        if (result.exitCode !== 0)
          throw new Error(`kosa8 could not end the command: ${failure(result)}`);
      },
      { attempts: 3 },
    );
    return;
  } catch (error) {
    if (isSandboxGoneError(translate(error, id))) return;
    if (!sleep) throw error;
    try {
      await sleep();
    } catch (sleepError) {
      throw new SandboxUnsafeStopError(
        "kosa8 command termination failed and the safety stop could not be completed; the computer may still be running",
        new AggregateError([cause, error, sleepError]),
      );
    }
    throw new SandboxUnsafeStopError(
      "kosa8 computer was put to sleep after command termination failed; the command may remain suspended",
      new AggregateError([cause, error]),
    );
  }
}

function failure(result: CommandResult): string {
  return (result.stderr || result.stdout).trim().slice(-2_000) || `exit ${result.exitCode}`;
}

function notRunning(state: string): Error {
  const error = new Error(`kosa8 computer is ${state}`);
  error.name = "SandboxNotRunningError";
  return error;
}

function sizedTemplate(template: string, size: ComputerSize): string {
  const { vcpus, memoryGb } = COMPUTER_SIZE_SPECS[size];
  return `${template}-${vcpus}x${memoryGb}`;
}

function newest<T extends { name: string | null; state: string }>(entries: T[], name: string) {
  const named = entries.filter((entry) => entry.name === name && entry.state !== "deleted");
  return named.find((entry) => entry.state === "ready") ?? named[0];
}

/**
 * A 404 means the computer is gone only when `id` names the computer the call was about: a
 * missing file inside it answers 404 too.
 */
export function translate(error: unknown, id?: string, sized = false): unknown {
  if (isSandboxUnsafeStopError(error) || !(error instanceof Kosa8ApiError)) return error;
  if (error.status === 429)
    return new SandboxRateLimitError({
      cause: error,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    });
  if (sized && error.status === 402 && ["plan_limit", "plan_feature"].includes(error.code))
    return new SandboxSizeUnavailableError("not_offered", { cause: error });
  // The deployment's own kosa8 account: unpaid, without a plan, frozen, or a revoked key.
  if ([401, 402, 403, 423].includes(error.status))
    return new SandboxProviderAccountError({ cause: error });
  if (id && error.status === 404)
    return sandboxNotFoundError(`kosa8 sandbox ${id} not found`, { cause: error });
  if (error.status >= 500)
    return new SandboxUnresponsiveError("kosa8 could not complete the request", { cause: error });
  return error;
}
