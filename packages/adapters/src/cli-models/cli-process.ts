import type { ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@rakazo/logging";

/**
 * What a signed-in CLI needs to find its own sign-in, reach the network and run; nothing else.
 * A CLI adds only the names its own sign-in or config folder lives under.
 */
const PASSTHROUGH_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_ADDRESS",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_NAME",
  "LC_PAPER",
  "LC_TELEPHONE",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Windows essentials.
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
]);

/**
 * A CLI's whole environment, built from an allowlist. API keys, OAuth tokens and every other
 * server secret stay out, so the CLI can only use the sign-in its operator made.
 */
export function cliEnv(
  source: NodeJS.ProcessEnv,
  ownNames: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (PASSTHROUGH_ENV.has(key) || ownNames.includes(key))) {
      env[key] = value;
    }
  }
  return env;
}

const stoppedProcesses = new WeakSet<ChildProcess>();

/**
 * Stops a CLI and everything it started. The CLI must have been spawned `detached` outside
 * Windows, so it leads its own process group.
 */
export function stopProcessTree(child: ChildProcess): void {
  if (stoppedProcesses.has(child)) return;
  stoppedProcesses.add(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    // Gone already is the usual reason; anything else leaves a process running, so it is logged.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      getLogger().warn("A CLI could not be stopped", { pid: child.pid, error });
    }
  }
}

/**
 * This OS user's private folder of this name, the same in every process, or else a new one of
 * this process's own (when the shared one belongs to someone else, or is not empty when it must be).
 */
export function privateFolder(name: string, empty: boolean): () => string {
  let own: string | undefined;
  return () => {
    const uid = process.getuid?.();
    const folder = join(tmpdir(), `${name}-${uid ?? "user"}`);
    try {
      mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = lstatSync(folder);
    // Windows has no owner or mode bits here; its temp folder is already the user's own.
    const mine =
      info.isDirectory() && (uid === undefined || (info.uid === uid && (info.mode & 0o077) === 0));
    if (mine && (!empty || readdirSync(folder).length === 0)) {
      return folder;
    }
    own ??= mkdtempSync(join(tmpdir(), `${name}-`));
    return own;
  };
}
