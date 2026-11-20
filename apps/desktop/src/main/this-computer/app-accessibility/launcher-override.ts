import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
function scriptFor(entry: DesktopEntry, program: string, dirs: LauncherDirs) {
  const file = path.join(dirs.scripts, entry.id.replace(/\.desktop$/, ""), path.basename(program));
  const text = [
    "#!/bin/sh",
    "# Written by Rakazo so bots can read this app. Turning off computer access in Rakazo removes it.",
    "export ACCESSIBILITY_ENABLED=1",
    `exec ${shellQuote(program)} --force-renderer-accessibility "$@"`,
    "",
  ].join("\n");
  return { file, text };
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
  const program = execProgram(entry.keys.get("Exec") ?? "");
  if (!program) throw new Error(`${entry.id} starts no program of its own`);
  const script = scriptFor(entry, program, dirs);
  await writeAtomically(script.file, script.text, 0o755);
  await writeAtomically(
    path.join(dirs.user, entry.id),
    overrideText(entry, program, script.file),
    0o644,
  );
}

async function rakazoLaunchers(dirs: LauncherDirs) {
  return (await readDesktopEntries([dirs.user])).filter((entry) => isRakazoLauncher(entry.text));
}

async function removeLauncher(entry: DesktopEntry, dirs: LauncherDirs) {
  await rm(entry.file, { force: true });
  await rm(path.join(dirs.scripts, entry.id.replace(/\.desktop$/, "")), {
    recursive: true,
    force: true,
  });
}

/** Removes every entry and script Rakazo wrote, leaving the user's own entries alone. */
export async function removeLaunchers(dirs: LauncherDirs) {
  for (const entry of await rakazoLaunchers(dirs)) await removeLauncher(entry, dirs);
  await rm(dirs.scripts, { recursive: true, force: true });
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
    if (!source || !execProgram(source.keys.get("Exec") ?? "")) await removeLauncher(entry, dirs);
    else if (written !== sha256(source.text)) await writeLauncher(source, dirs);
  }
}

/** Whether the user's folder already hides the system entry `id`, and with whose entry. */
export async function launcherOwner(id: string, dirs: LauncherDirs) {
  const own = (await readDesktopEntries([dirs.user])).find((entry) => entry.id === id);
  if (!own) return undefined;
  return isRakazoLauncher(own.text) ? "rakazo" : "user";
}
