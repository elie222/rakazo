import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

/** One of this user's processes, as `/proc` shows it. */
export interface UserProcess {
  pid: number;
  ppid: number;
  /** The command name, which the kernel cuts to 15 characters. */
  comm: string;
  /** Empty when the process hides it. */
  exe: string;
  argv: string[];
}

const UNSET_LOGIN_SESSION = "4294967295";
/** The kernel keeps only this many characters of a process's command name. */
const COMMAND_NAME_LENGTH = 15;

/** The login session a process was started in, unless the kernel didn't record one. */
async function loginSession(dir: string): Promise<string | undefined> {
  let id: string;
  try {
    id = (await readFile(path.join(dir, "sessionid"), "utf8")).trim();
  } catch (error) {
    // A kernel built without login sessions has no such file.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
  return id && id !== UNSET_LOGIN_SESSION ? id : undefined;
}

/**
 * This user's processes in this login session, read from `/proc`. A process's own environment
 * can't place it in a session: Chromium overwrites it.
 */
export async function userProcesses(proc = "/proc"): Promise<UserProcess[]> {
  const uid = process.getuid?.();
  const session = await loginSession(path.join(proc, "self"));
  const found: UserProcess[] = [];
  for (const entry of await readdir(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    const dir = path.join(proc, entry);
    try {
      // A process that blocks debugging has a root-owned folder, so read its owner from status.
      const status = await readFile(path.join(dir, "status"), "utf8");
      const owner = /^Uid:\s+(\d+)/m.exec(status)?.[1];
      if (uid !== undefined && (owner === undefined || Number(owner) !== uid)) continue;
      // An app open in the user's other graphical session has no window in this one.
      const theirs = session && (await loginSession(dir));
      if (theirs && theirs !== session) continue;
      const comm = (await readFile(path.join(dir, "comm"), "utf8")).trim();
      // A process that made itself non-dumpable hides its executable even from its own user.
      const exe = await readlink(path.join(dir, "exe")).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EACCES" && code !== "EPERM") throw error;
        return "";
      });
      let argv = (await readFile(path.join(dir, "cmdline"), "utf8")).split("\0");
      if (argv.at(-1) === "") argv.pop();
      // Chromium rewrites its processes' titles, joining their arguments with spaces.
      if (argv.length === 1 && argv[0]?.includes(" --")) argv = argv[0].split(" ");
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      found.push({ pid: Number(entry), ppid, comm, exe, argv });
    } catch (error) {
      // The process exited while it was being read: Linux answers ENOENT or ESRCH.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") throw error;
    }
  }
  return found;
}

/** Whether a process runs as `name`: its executable, or its command and script names. */
export function isNamed(running: UserProcess, name: string): boolean {
  const wanted = name.trim().toLowerCase();
  if (path.basename(running.exe).toLowerCase() === wanted) return true;
  // An app on a shared Electron runtime is named only by the folder of the archive it runs.
  if (
    running.argv.some(
      (arg) => arg.endsWith(".asar") && path.basename(path.dirname(arg)).toLowerCase() === wanted,
    )
  )
    return true;
  // A script's command name is its own, cut short; its executable is the interpreter.
  const command = wanted.slice(0, COMMAND_NAME_LENGTH);
  if (running.comm.toLowerCase() !== command) return false;
  if (command === wanted) return true;
  // A cut name matches every script sharing its first characters, so check the script's own.
  return running.argv.slice(0, 2).some((arg) => path.basename(arg).toLowerCase() === wanted);
}
