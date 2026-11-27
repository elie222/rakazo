import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopEntry } from "./desktop-entries.js";
import {
  applicationDirs,
  execProgram,
  readDesktopEntries,
  withExecProgram,
} from "./desktop-entries.js";

/** Marks an entry Rakazo wrote, holding a hash of the system entry it was made from. */
const MARK = "X-Rakazo-Launcher";

/** Where entries and their start scripts go: the user's own folders, never the system's. */
export interface LauncherDirs {
  /** The user's applications folder, which hides a system entry with the same file name. */
  user: string;
  system: string[];
  /** The start scripts, outside the app's own data so they keep working without it. */
  scripts: string;
}

/** The user's and the system's entries, with the scripts beside the user's data. */
export function launcherDirs(env: NodeJS.ProcessEnv, home: string): LauncherDirs {
  const dirs = applicationDirs(env, home);
  return { ...dirs, scripts: path.join(path.dirname(dirs.user), "rakazo", "launchers") };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Whether Rakazo wrote this entry text. */
export function isRakazoLauncher(text: string) {
  return new RegExp(`^${MARK}=`, "m").test(text);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The script keeps the program's own name, since launchers that focus an open window match it.
 * Chromium joins the accessibility bus only with the variable set, and shares page content only
 * with the option.
 */
/** The folder of an entry's script, or undefined for a file name that could leave the scripts' folder. */
function scriptDir(id: string, dirs: LauncherDirs) {
  const name = id.replace(/\.desktop$/, "");
  return SAFE_NAME.test(name) ? path.join(dirs.scripts, name) : undefined;
}
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** Launchers that keep only an Exec line's first word split it at spaces, so the path keeps to these. */
const SAFE_PATH = /^[A-Za-z0-9._/+@-]+$/;

/** Where the entry's script goes, unless its names or the folder's path couldn't be run. */
function scriptFile(entry: DesktopEntry, dirs: LauncherDirs) {
  const program = execProgram(entry.keys.get("Exec") ?? "");
  const dir = scriptDir(entry.id, dirs);
  if (!program || !dir || !SAFE_NAME.test(path.basename(program))) return undefined;
  const file = path.join(dir, path.basename(program));
  return SAFE_PATH.test(file) ? { file, program } : undefined;
}

/**
 * Whether Rakazo can start this entry's app through a script: it starts a program of its own,
 * by a path a launcher keeps whole, and not over D-Bus, which skips the Exec line.
 */
export function canWriteLauncher(entry: DesktopEntry, dirs: LauncherDirs) {
  return entry.keys.get("DBusActivatable") !== "true" && scriptFile(entry, dirs) !== undefined;
}

function scriptFor(entry: DesktopEntry, dirs: LauncherDirs) {
  const found = scriptFile(entry, dirs);
  if (!found) throw new Error(`${entry.id} can't be started through a script`);
  const { file, program } = found;
  const text = [
    "#!/bin/sh",
    "# Written by Rakazo so bots can read this app. Turning off computer access in Rakazo removes it.",
    "export ACCESSIBILITY_ENABLED=1",
    `exec ${shellQuote(program)} --force-renderer-accessibility "$@"`,
    "",
  ].join("\n");
  return { file, text, program };
}

/** The entry with every Exec of `program` pointed at the script, marked as Rakazo's. */
function overrideText(entry: DesktopEntry, program: string, script: string) {
  return entry.text
    .split("\n")
    .map((line) => {
      if (/^\[Desktop Entry\]\s*$/.test(line)) return `${line}\n${MARK}=${sha256(entry.text)}`;
      const exec = /^Exec\s*=\s*(.*)$/.exec(line)?.[1];
      if (exec === undefined || execProgram(exec) !== program) return line;
      return `Exec=${withExecProgram(exec, script)}`;
    })
    .join("\n");
}

async function writeAtomically(file: string, text: string, mode: number) {
  await mkdir(path.dirname(file), { recursive: true });
  const staging = `${file}.rakazo-${process.pid}`;
  await writeFile(staging, text, { mode });
  await chmod(staging, mode);
  await rename(staging, file);
}

/** Writes the start script and the user entry that hides `entry`, a system entry. */
export async function writeLauncher(entry: DesktopEntry, dirs: LauncherDirs) {
  const script = scriptFor(entry, dirs);
  await writeAtomically(script.file, script.text, 0o755);
  await writeAtomically(
    path.join(dirs.user, entry.id),
    overrideText(entry, script.program, script.file),
    0o644,
  );
}

async function rakazoLaunchers(dirs: LauncherDirs) {
  return (await readDesktopEntries([dirs.user])).filter((entry) => isRakazoLauncher(entry.text));
}

async function removeLauncher(entry: DesktopEntry, dirs: LauncherDirs) {
  await rm(entry.file, { force: true });
  const dir = scriptDir(entry.id, dirs);
  if (dir) await rm(dir, { recursive: true, force: true });
}

/** The program Rakazo's entry starts: its script keeps the program's own name. */
function approvedProgram(entry: DesktopEntry) {
  return path.basename(execProgram(entry.keys.get("Exec") ?? "") ?? "");
}

/** Removes every entry and script Rakazo wrote, leaving the user's own entries alone. */
export async function removeLaunchers(dirs: LauncherDirs) {
  for (const entry of await rakazoLaunchers(dirs)) await removeLauncher(entry, dirs);
  await rm(dirs.scripts, { recursive: true, force: true });
  // The folder the scripts went in, unless something else lives there too.
  await rmdir(path.dirname(dirs.scripts)).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  });
}

/**
 * Brings Rakazo's entries up to date with the system entries they hide: an app update can change
 * its entry, and an uninstalled app leaves nothing to hide.
 */
export async function refreshLaunchers(dirs: LauncherDirs) {
  const ours = await rakazoLaunchers(dirs);
  if (!ours.length) return;
  const system = new Map((await readDesktopEntries(dirs.system)).map((entry) => [entry.id, entry]));
  for (const entry of ours) {
    const source = system.get(entry.id);
    const written = new RegExp(`^${MARK}=(\\w+)`, "m").exec(entry.text)?.[1];
    const program = execProgram(source?.keys.get("Exec") ?? "");
    // The user allowed one program; an entry that now starts another needs their say again.
    if (!source || !program || path.basename(program) !== approvedProgram(entry))
      await removeLauncher(entry, dirs);
    else if (written !== sha256(source.text)) await writeLauncher(source, dirs);
  }
}

/** Whether the user's folder already hides the system entry `id`, and with whose entry. */
export async function launcherOwner(id: string, dirs: LauncherDirs) {
  const own = (await readDesktopEntries([dirs.user])).find((entry) => entry.id === id);
  if (!own) return undefined;
  return isRakazoLauncher(own.text) ? "rakazo" : "user";
}
