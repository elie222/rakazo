import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** An app launcher entry: a `.desktop` file under an `applications` folder. */
export interface DesktopEntry {
  /** The file name, which an entry of the same name in an earlier folder hides. */
  id: string;
  file: string;
  text: string;
  /** The keys of the [Desktop Entry] group. */
  keys: Map<string, string>;
}

/** The user's own entries first, then the system's, as launchers search them. */
export function applicationDirs(env: NodeJS.ProcessEnv, home: string) {
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return {
    user: path.join(dataHome, "applications"),
    system: dataDirs.map((dir) => path.join(dir, "applications")),
  };
}

function mainGroup(text: string) {
  const keys = new Map<string, string>();
  let inMain = false;
  for (const line of text.split("\n")) {
    const header = /^\[(.+)\]\s*$/.exec(line);
    if (header) inMain = header[1] === "Desktop Entry";
    else if (inMain) {
      const pair = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
      if (pair?.[1] && !keys.has(pair[1])) keys.set(pair[1], pair[2] ?? "");
    }
  }
  return keys;
}

/** The entries in `dirs`, keeping the first of each id. A missing folder has none. */
export async function readDesktopEntries(dirs: string[]): Promise<DesktopEntry[]> {
  const entries = new Map<string, DesktopEntry>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    for (const id of names.sort()) {
      if (!id.endsWith(".desktop") || entries.has(id)) continue;
      const file = path.join(dir, id);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        // A broken link or a folder with an entry's name is no entry.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "EISDIR") throw error;
        continue;
      }
      entries.set(id, { id, file, text, keys: mainGroup(text) });
    }
  }
  return [...entries.values()];
}

/** An Exec line's first word, unquoted as the desktop entry spec quotes it, and the rest. */
function splitExec(exec: string) {
  const line = exec.trimStart();
  if (!line.startsWith('"')) {
    const program = line.split(/\s/, 1)[0] ?? "";
    return { program, rest: line.slice(program.length) };
  }
  const close = /(?<!\\)"/g;
  close.lastIndex = 1;
  const end = close.exec(line);
  if (!end) return undefined;
  const program = line.slice(1, end.index).replace(/\\(["`$\\])/g, "$1");
  return { program, rest: line.slice(end.index + 1) };
}

/**
 * The program an Exec line runs. Undefined when another program starts it, such as env, a shell
 * or a sandbox runner, since changing how that program starts wouldn't reach the app.
 */
export function execProgram(exec: string): string | undefined {
  const program = splitExec(exec)?.program;
  if (!program || program.includes("=")) return undefined;
  return LAUNCHING_PROGRAMS.has(path.basename(program)) ? undefined : program;
}

/** The Exec line with its program replaced, keeping its arguments and field codes. */
export function withExecProgram(exec: string, program: string): string {
  const quoted = /[\s"'\\`$]/.test(program)
    ? `"${program.replace(/(["`$\\])/g, "\\$1")}"`
    : program;
  return `${quoted}${splitExec(exec)?.rest ?? ""}`;
}
const LAUNCHING_PROGRAMS = new Set(["env", "flatpak", "snap", "sh", "bash"]);

/** The programs the entries named `app` run: by file name, displayed name or window class. */
export function entryPrograms(app: string, entries: DesktopEntry[]): string[] {
  const wanted = app.trim().toLowerCase();
  const programs = entries.flatMap((entry) => {
    const names = [
      entry.id.replace(/\.desktop$/, ""),
      entry.keys.get("Name"),
      entry.keys.get("StartupWMClass"),
    ];
    if (!names.some((name) => name?.toLowerCase() === wanted)) return [];
    const exec = entry.keys.get("Exec") ?? "";
    const program = execProgram(exec);
    if (!program) return [];
    // An app archive on a shared runtime is named by its folder, as its process is.
    const archive = exec.split(/\s+/).find((word) => word.endsWith(".asar"));
    return [archive ? path.basename(path.dirname(archive)) : path.basename(program)];
  });
  return [...new Set(programs)];
}
