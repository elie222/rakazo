import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { NativeProcessTree } from "../providers/computer/desktop/desktop-process-tree.js";
import type { HostProcessMarker } from "./host-process-macos.js";
import { macosHostOwnershipAvailable, spawnMacosHostCommand } from "./host-process-macos.js";
import { spawnWindowsHostCommand } from "./host-process-windows.js";

const program = String.raw`
import ctypes, json, os, pathlib, signal, subprocess, sys, threading, time
# Establish ownership before launching anything; unsupported kernels fail closed.
if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
    raise RuntimeError('pidfd_unavailable')
probe = os.pidfd_open(os.getpid())
signal.pidfd_send_signal(probe, 0)
os.close(probe)
for task in pathlib.Path('/proc/self/task').iterdir():
    (task / 'children').read_text()
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise RuntimeError('subreaper_unavailable')

def cleanup_children():
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        # Only signal direct children. Killing a parent reparents even setsid/double-fork
        # descendants to this subreaper; repeat until waitpid confirms ECHILD.
        children = set()
        try:
            for task in pathlib.Path('/proc/self/task').iterdir():
                try: children.update(map(int, (task / 'children').read_text().split()))
                except FileNotFoundError: pass
            for pid in children:
                try:
                    fd = os.pidfd_open(pid)
                except ProcessLookupError: continue
                try:
                    row = pathlib.Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
                    # Recheck parent after opening the stable handle: a recycled PID can
                    # never authorize signalling an unrelated process.
                    if int(row[1]) != os.getpid(): continue
                    signal.pidfd_send_signal(fd, signal.SIGSTOP)
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                except (ProcessLookupError, FileNotFoundError): pass
                finally: os.close(fd)
            while True:
                try:
                    if os.waitpid(-1, os.WNOHANG)[0] == 0: break
                except ChildProcessError: return True
        except (OSError, ValueError, IndexError):
            # An incomplete scan is never evidence of successful cleanup.
            pass
        time.sleep(0.02)
    return False
if len(sys.argv) > 1: sys.exit(0)
control = os.fdopen(3, 'rb')
status = os.fdopen(4, 'w')
config = json.loads(control.readline(1024 * 1024))
stopping = threading.Event()
def watch_owner():
    try: control.read(1)
    finally: stopping.set()
threading.Thread(target=watch_owner, daemon=True).start()
for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(signum, lambda *_: stopping.set())
try:
    child = subprocess.Popen(config['argv'], cwd=config['cwd'], env=config['env'],
        stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer, start_new_session=True)
except OSError:
    status.write('clean\n'); status.flush()
    sys.exit(1)
code = None
while not stopping.wait(.02):
    code = child.poll()
    if code is not None: break
# EOF on the private owner pipe also cleans up after an Electron crash. Keep owning
# children if a bounded cleanup attempt fails; later Stop/Quit can still confirm it.
while not cleanup_children(): pass
status.write('clean\n'); status.flush(); status.close()
sys.exit(code if code is not None and code >= 0 else 0)
`;

export async function hostProcessOwnershipAvailable(platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") return true;
  if (platform === "darwin") return macosHostOwnershipAvailable();
  if (platform !== "linux") return false;
  return new Promise<boolean>((resolve) => {
    execFile(
      "/usr/bin/python3",
      ["-I", "-u", "-c", program, "probe"],
      { env: {}, timeout: 3000, maxBuffer: 1024 },
      (error) => resolve(!error),
    );
  });
}

export async function spawnOwnedHostCommand(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  marker?: HostProcessMarker,
): Promise<{
  child: ChildProcessWithoutNullStreams;
  tree: NativeProcessTree;
}> {
  if (process.platform === "win32") return spawnWindowsHostCommand(argv, cwd, env);
  if (process.platform === "darwin") return spawnMacosHostCommand(argv, cwd, env, marker);
  if (process.platform !== "linux") throw new Error("host_process_ownership_unavailable");
  const child = spawn("/usr/bin/python3", ["-I", "-u", "-c", program], {
    cwd,
    env: {},
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const control = child.stdio[3] as Writable;
  const status = child.stdio[4] as Readable;
  let clean = false;
  child.once("error", () => {
    // A failed OS spawn never ran the supervisor or any CLI descendants.
    if (!child.pid) clean = true;
  });
  let acknowledgement = "";
  status.setEncoding("utf8");
  status.on("data", (chunk: string) => {
    acknowledgement += chunk;
    clean = acknowledgement === "clean\n";
  });
  control.on("error", () => {});
  status.on("error", () => {});
  control.write(`${JSON.stringify({ argv, cwd, env })}\n`);
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
