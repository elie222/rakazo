import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { createRequire as createHostRequire } from "node:module";
import type { Readable, Writable } from "node:stream";
import type { NativeProcessTree } from "../providers/computer/desktop/desktop-process-tree.js";

export interface HostProcessMarker {
  directory: string;
  allow: string;
  deny: string;
}

const markerFiles = new WeakMap<HostProcessMarker, number[]>();
const markerDirectory = () => `/private/tmp/rakazo-host-markers-${process.getuid!()}`;

export function assertHostMarkerWorkspace(workspace: string) {
  const directory = markerDirectory();
  if (workspace.toLowerCase() === directory || workspace.toLowerCase().startsWith(`${directory}/`))
    throw new Error("host_workspace_reserved");
}

/** The owner inherits open handles to every original object, preventing inode reuse. */
export async function createHostProcessMarker(): Promise<HostProcessMarker> {
  for (const ancestor of ["/private", "/private/tmp"]) {
    const info = lstatSync(ancestor);
    if (
      realpathSync.native(ancestor) !== ancestor ||
      !info.isDirectory() ||
      info.uid !== 0 ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    )
      throw new Error("host_process_marker_unavailable");
  }
  const directory = markerDirectory();
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const marker = {
    directory,
    allow: `${directory}/${randomUUID()}-allow`,
    deny: `${directory}/${randomUUID()}-deny`,
  };
  const fds: number[] = [];
  try {
    fds.push(
      openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
    );
    const info = fstatSync(fds[0]!);
    if (
      info.uid !== process.getuid!() ||
      (info.mode & 0o7777) !== 0o700 ||
      realpathSync.native(directory) !== directory
    )
      throw new Error("host_process_marker_unavailable");
    for (const file of [marker.allow, marker.deny])
      fds.push(
        openSync(
          file,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        ),
      );
    markerFiles.set(marker, fds);
    return marker;
  } catch (error) {
    markerFiles.set(marker, fds);
    releaseMarker(marker, true);
    throw error;
  }
}

export function discardHostProcessMarker(marker: HostProcessMarker) {
  releaseMarker(marker, true);
}

function releaseMarker(marker: HostProcessMarker, remove: boolean) {
  const fds = markerFiles.get(marker);
  if (!fds) return;
  if (remove) {
    for (const [index, file] of [marker.allow, marker.deny].entries()) {
      try {
        const original = fstatSync(fds[index + 1]!);
        const current = lstatSync(file);
        if (original.dev === current.dev && original.ino === current.ino) unlinkSync(file);
      } catch {
        /* A missing/replaced object is never removed. */
      }
    }
  }
  for (const fd of fds) closeSync(fd);
  markerFiles.delete(marker);
}

// This is a separate Node process, outside the CLI's sandbox. The existing native FFI
// dependency is also shipped outside asar. No compiler, Python, service, or root is needed.
// libproc/sandbox SPI is capability-probed; unsupported OS versions fail admission.
export const MACOS_HOST_OWNER = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { Socket } = require('node:net');
const koffi = require(process.argv[1]);
const system = koffi.load('/usr/lib/libproc.dylib');
const sandbox = koffi.load('/usr/lib/libsandbox.dylib');
const list = system.func('int proc_listpids(uint32_t, uint32_t, void *, int)');
const info = system.func('int proc_pidinfo(int, int, uint64_t, void *, int)');
const signal = system.func('int proc_signal_with_audittoken(void *, int)');
const check = sandbox.func('int sandbox_check(int, const char *, int, ...)');
const noReport = koffi.decode(sandbox.symbol('SANDBOX_CHECK_NO_REPORT'), 'int');
const descriptor = koffi.load('/usr/lib/libSystem.B.dylib').func('int fcntl(int, int, ...)');
function privateDescriptors(first = 3) {
  // FD_CLOEXEC applies even if a spawn implementation otherwise preserves extra FDs.
  // Only the owner's control/status pipes and marker handles may ever use these.
  for (let fd = first; fd <= 7; fd++) {
    const flags = descriptor(fd, 1); // F_GETFD
    if (flags < 0 || descriptor(fd, 2, 'int', flags | 1) < 0) // F_SETFD, FD_CLOEXEC
      throw new Error('host_private_descriptor_unavailable');
  }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function markerGuard(marker) {
  const paths = [marker.directory, marker.allow, marker.deny];
  const original = paths.map((_, index) => fs.fstatSync(5 + index, { bigint: true }));
  function validate() {
    for (const [index, path] of paths.entries()) {
      const current = fs.lstatSync(path, { bigint: true });
      const held = fs.fstatSync(5 + index, { bigint: true });
      if (current.dev !== original[index].dev || current.ino !== original[index].ino ||
          held.dev !== original[index].dev || held.ino !== original[index].ino ||
          current.uid !== BigInt(process.getuid()) ||
          (current.mode & 0o7777n) !== (index === 0 ? 0o700n : 0o600n) ||
          (index === 0 ? !current.isDirectory() : !current.isFile()) ||
          fs.realpathSync.native(path) !== path) throw new Error('host_process_marker_changed');
    }
  }
  validate();
  return {
    validate,
    remove() {
      validate();
      for (const path of [marker.allow, marker.deny]) {
        try { fs.unlinkSync(path); } catch { /* Cleanup is confirmed; a leftover private file is harmless. */ }
      }
      for (let fd = 5; fd <= 7; fd++) fs.closeSync(fd);
    }
  };
}
function identity(pid) {
  const data = Buffer.alloc(56); // proc_uniqidentifierinfo, PROC_PIDUNIQIDENTIFIERINFO
  if (info(pid, 17, 0, data, data.length) !== data.length) return;
  const token = Buffer.alloc(32); // audit_token_t; kernel checks PID and pidversion.
  token.writeUInt32LE(pid, 20);
  token.writeUInt32LE(data.readUInt32LE(32), 28);
  return { pid, unique: data.readBigUInt64LE(16), parent: data.readBigUInt64LE(24), token };
}
function zombie(pid) {
  // proc_listpids includes zombies owned by unrelated parents; they cannot fork.
  const state = Buffer.alloc(64); // proc_bsdshortinfo, PROC_PIDT_SHORTBSDINFO
  return info(pid, 13, 1, state, state.length) === state.length && state.readUInt32LE(12) === 5;
}
function allowed(pid, path) {
  const result = check(pid, 'file-read-data', 1 | noReport, 'str', path);
  if (result < 0) throw new Error('host_process_label_unavailable');
  return result === 0;
}
function matches(pid, marker) {
  marker.guard.validate();
  const result = allowed(pid, marker.allow) && !allowed(pid, marker.deny);
  marker.guard.validate();
  return result;
}
function enumerate() {
  // PROC_UID_ONLY: never inspect other users' sandboxes. Retry if the list grew.
  for (;;) {
    const length = list(4, process.getuid(), null, 0);
    if (length <= 0) throw new Error('host_process_list_unavailable');
    const data = Buffer.alloc(length + 4096);
    const size = list(4, process.getuid(), data, data.length);
    if (size <= 0) throw new Error('host_process_list_unavailable');
    if (size === data.length) continue;
    return Array.from({ length: Math.floor(size / 4) }, (_, index) => data.readInt32LE(index * 4))
      .filter(pid => pid > 0 && pid !== process.pid);
  }
}
function send(target, signum) {
  const result = signal(target.token, signum);
  // libproc returns errno, not -1. ESRCH includes an exited/reused/exec'd identity.
  if (result !== 0 && result !== 3) throw new Error('host_process_signal_unavailable');
  return result === 0;
}
async function cleanup(root, marker, family = new Set(root ? [root.unique] : [])) {
  // Stop the root first. Its unique ID survives exec; pidversion prevents signalling
  // a different exec image between reading its identity and the native signal call.
  marker.guard.validate();
  const current = root && identity(root.pid);
  if (current && current.unique === root.unique) { send(current, 17); send(current, 9); }
  const deadline = Date.now() + 10000;
  let empty;
  while (Date.now() < deadline) {
    const owned = [];
    const pids = enumerate();
    const identities = [];
    let stable = true;
    for (const pid of pids) {
      const target = identity(pid);
      if (target) identities.push(target);
      else if (!zombie(pid)) stable = false;
    }
    // Native CLI helpers need not enter a tool sandbox. Original-parent unique IDs
    // identify those helpers even after the CLI exits and launchd reparents them.
    // Detached tool chains use the inherited sandbox label, not this ancestry scan.
    let changed;
    do {
      changed = false;
      for (const target of identities) {
        if (family.has(target.parent) && !family.has(target.unique)) {
          family.add(target.unique); changed = true;
        }
      }
    } while (changed);
    for (const before of identities) {
      const pid = before.pid;
      let match;
      try { match = family.has(before.unique) || matches(pid, marker); }
      catch (error) { if (!identity(pid)) { stable = false; continue; } throw error; }
      if (!match) continue;
      const after = identity(pid);
      if (!after || !after.token.equals(before.token)) { stable = false; continue; }
      marker.guard.validate();
      if (!send(after, 17)) stable = false; // freeze before killing so the matching population cannot grow.
      owned.push(after);
    }
    for (const target of owned) { marker.guard.validate(); send(target, 9); }
    // A parent may fork then exit after proc_listpids took its snapshot. Never
    // confirm cleanup from that one empty scan; require a second complete scan
    // with the same stable process identities and no matching process remaining.
    const snapshot = identities.map(target => target.unique.toString() + ':' + target.token.readUInt32LE(28)).sort().join(',');
    if (stable && owned.length === 0) {
      if (empty === snapshot) { marker.guard.validate(); return; }
      empty = snapshot;
    } else empty = undefined;
    await pause(20);
  }
  throw new Error('host_stop_unconfirmed');
}
function profile(marker) {
  return '(version 1)(allow default)' +
    '(deny file-read* (require-all (subpath ' + JSON.stringify(marker.directory) + ')' +
    '(require-not (literal ' + JSON.stringify(marker.allow) + '))))' +
    '(deny file-write* (subpath ' + JSON.stringify(marker.directory) + '))';
}
async function probe() {
  const marker = JSON.parse(process.argv[3]);
  marker.guard = markerGuard(marker);
  privateDescriptors(5);
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile(marker), '/bin/sleep', '5'], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  let root, stage = 'label', positive = false, negative = false, selfMatch = false;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      root = identity(child.pid);
      if (root) {
        positive = allowed(child.pid, marker.allow);
        negative = allowed(child.pid, marker.deny);
        if (positive && !negative) break;
      }
      await pause(10);
    }
    selfMatch = matches(process.pid, marker);
    if (!root || !positive || negative || selfMatch) throw new Error('host_process_label_unavailable');
    stage = 'signal';
    // sandbox-exec can exec after its label becomes visible. Refresh the audit
    // token so admission also tests signalling the final executable identity.
    const current = identity(child.pid);
    if (!current || current.unique !== root.unique || !send(current, 17) || !send(current, 9))
      throw new Error('host_process_signal_unavailable');
    stage = 'exit';
    await closed;
    stage = 'cleanup';
    await cleanup(root, marker);
    marker.guard.remove();
  } catch (error) {
    // Only capability facts, never PIDs, command output, paths, or account data.
    fs.writeSync(2, 'host_owner_probe ' + JSON.stringify({ stage, identity: !!root, positive, negative, selfMatch, exited: child.exitCode !== null || child.signalCode !== null }) + '\n');
    throw error;
  } finally { child.kill('SIGKILL'); }
}
async function main() {
  if (process.argv[2] === 'probe') { await probe(); return; }
  // libuv's inherited stdio pipe is a socket. fs.ReadStream would block a worker
  // in read(2); process.exit then waits forever unless the desktop first sends EOF.
  // The socket handle lets a naturally exiting CLI finish while its owner is open.
  const control = new Socket({ fd: 3, readable: true, writable: false });
  control.setEncoding('utf8');
  let config = '', launched = false, stopping = false, root, marker, child, code = 0, unavailableRoot = false;
  let attempt;
  const stop = () => {
    stopping = true;
    if (!launched) {
      fs.writeSync(4, 'clean\n'); fs.closeSync(4); process.exit(0);
    }
    if (attempt) return;
    attempt = (async () => {
      // Keep owning after a failed bounded attempt; the desktop can retry Stop/Quit.
      const family = new Set(root ? [root.unique] : []);
      for (;;) {
        try {
          if (unavailableRoot && child.exitCode === null && child.signalCode === null) throw new Error('host_root_identity_unavailable');
          await cleanup(root, marker, family); marker.guard.remove(); break;
        }
        catch { await pause(100); }
      }
      fs.writeSync(4, 'clean\n');
      fs.closeSync(4);
      process.exit(code);
    })();
  };
  control.on('end', stop); control.on('error', stop);
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, stop);
  control.on('data', data => {
    if (launched || stopping) return;
    config += data;
    if (config.length > 1024 * 1024) process.exit(1);
    const newline = config.indexOf('\n');
    if (newline < 0) return;
    const value = JSON.parse(config.slice(0, newline));
    marker = value.marker;
    marker.guard = markerGuard(marker);
    privateDescriptors();
    const argv = value.sandboxRoot
      ? ['/usr/bin/sandbox-exec', '-p', profile(marker), ...value.argv] : value.argv;
    child = spawn(argv[0], argv.slice(1), { cwd: value.cwd, env: value.env, stdio: ['pipe', 1, 2] });
    launched = true;
    child.once('error', () => { code = 1; stop(); });
    child.once('exit', status => { code = status === null ? 1 : status; stop(); });
    child.stdin.on('error', stop);
    root = child.pid && identity(child.pid);
    if (child.pid && !root) {
      unavailableRoot = true; code = 1; child.stdin.end(); stop();
    } else process.stdin.pipe(child.stdin);
    if (stopping) stop();
  });
}
main().catch(error => {
  // Bootstrap/native-loading failures also need bounded, path-free CI diagnostics.
  const code = /^host_[a-z_]+$/.test(error?.message) ? error.message : 'host_owner_initialization_failed';
  fs.writeSync(2, 'host_owner_failure ' + JSON.stringify({ code }) + '\n');
  process.exit(1);
});
`;

const modulePath = () => createHostRequire(import.meta.url).resolve("koffi");

export async function probeMacosHostOwnership(): Promise<{
  success: boolean;
  diagnostic?: string;
}> {
  let marker: HostProcessMarker | undefined;
  try {
    marker = await createHostProcessMarker();
    const fds = markerFiles.get(marker)!;
    const child = spawn(
      process.execPath,
      ["-e", MACOS_HOST_OWNER, modulePath(), "probe", JSON.stringify(marker)],
      {
        env: { ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "pipe", "ignore", "ignore", ...fds],
      },
    );
    releaseMarker(marker, !child.pid);
    return await new Promise((resolve) => {
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (data: string) => {
        if (stderr.length < 1024) stderr += data;
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ success: false });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({
          success: code === 0,
          diagnostic: stderr
            .split("\n")
            .find(
              (line) =>
                line.startsWith("host_owner_probe ") || line.startsWith("host_owner_failure "),
            ),
        });
      });
    });
  } catch {
    if (marker) releaseMarker(marker, true);
    return { success: false };
  }
}

export async function macosHostOwnershipAvailable() {
  return (await probeMacosHostOwnership()).success;
}

export async function spawnMacosHostCommand(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  marker?: HostProcessMarker,
): Promise<{ child: ChildProcessWithoutNullStreams; tree: NativeProcessTree }> {
  const koffiPath = modulePath();
  const actualMarker = marker ?? (await createHostProcessMarker());
  const fds = markerFiles.get(actualMarker);
  if (!fds) throw new Error("host_process_marker_unavailable");
  const child = spawn(process.execPath, ["-e", MACOS_HOST_OWNER, koffiPath], {
    cwd,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", ...fds],
  });
  releaseMarker(actualMarker, !child.pid);
  const control = child.stdio[3] as Writable;
  const status = child.stdio[4] as Readable;
  let clean = false;
  let acknowledgement = "";
  child.once("error", () => {
    if (!child.pid) clean = true;
  });
  status.setEncoding("utf8");
  status.on("data", (chunk: string) => {
    acknowledgement += chunk;
    clean = acknowledgement === "clean\n";
  });
  control.on("error", () => {});
  status.on("error", () => {});
  control.write(
    `${JSON.stringify({ argv, cwd, env, marker: actualMarker, sandboxRoot: !marker })}\n`,
  );
  return {
    child: child as ChildProcessWithoutNullStreams,
    tree: {
      alive: () => !clean,
      kill: () => control.end(),
      close() {
        if (clean) {
          control.destroy();
          status.destroy();
        }
      },
    },
  };
}
