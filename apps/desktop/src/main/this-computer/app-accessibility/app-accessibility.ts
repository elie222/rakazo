import path from "node:path";
import type { DesktopEntry } from "./desktop-entries.js";
import { entryPrograms, execProgram, readDesktopEntries } from "./desktop-entries.js";
import type { LauncherDirs } from "./launcher-override.js";
import {
  canWriteLauncher,
  launcherOwner,
  refreshLaunchers,
  removeLaunchers,
  writeLauncher,
} from "./launcher-override.js";
import type { UserProcess } from "./processes.js";
import { isNamed } from "./processes.js";

/** The option that makes a Chromium-engine app share page content, once it is on the bus. */
const SHARING_OPTION = "--force-renderer-accessibility";
/** The helper processes only the Chromium engine starts. */
const ENGINE_HELPERS = new Set(["--type=zygote", "--type=renderer"]);
/** The kernel keeps only this many characters of a process's command name. */
const COMMAND_NAME_LENGTH = 15;

/** Whether `running` descends from the process `pid`. */
function startedBy(running: UserProcess, pid: number, byPid: Map<number, UserProcess>) {
  const seen = new Set<number>();
  for (let parent = byPid.get(running.ppid); parent; parent = byPid.get(parent.ppid)) {
    if (parent.pid === pid) return true;
    if (seen.has(parent.pid)) return false;
    seen.add(parent.pid);
  }
  return false;
}

/** What `/proc` says about an open app: how it was started and what it runs on. */
export function inspectApp(app: string, processes: UserProcess[], selfPid: number) {
  const named = processes.filter((running) => isNamed(running, app));
  const main =
    named.find((running) => !running.argv.some((arg) => arg.startsWith("--type="))) ?? named[0];
  if (!main) return undefined;
  const byPid = new Map(processes.map((running) => [running.pid, running]));
  // Scripts that ran the app name it too: the kernel names a script's process after the script.
  // The name the app runs under, and the scripts that started it. Its executable alone could be
  // a shared runtime that other apps' entries start too.
  const launchers = [app];
  for (let parent = byPid.get(main.ppid); parent; parent = byPid.get(parent.ppid)) {
    const script = parent.argv[1];
    if (!script || path.basename(script).slice(0, COMMAND_NAME_LENGTH) !== parent.comm) break;
    launchers.push(path.basename(script));
  }
  return {
    self: named.some((running) => running.pid === selfPid),
    engine: processes.some(
      (helper) =>
        helper.argv.some((arg) => ENGINE_HELPERS.has(arg)) && startedBy(helper, main.pid, byPid),
    ),
    sharing: main.argv.includes(SHARING_OPTION),
    launchers: [...new Set(launchers.filter(Boolean))],
  };
}

/**
 * The system entry that starts the app: the one whose program is the app's own or a script that
 * ran it, preferring an entry named after its program, then one shown in launchers.
 */
export function launcherEntry(launchers: string[], entries: DesktopEntry[]) {
  const runs = (entry: DesktopEntry) => execProgram(entry.keys.get("Exec") ?? "");
  const matching = entries.filter((entry) => {
    const program = runs(entry);
    return program !== undefined && launchers.includes(path.basename(program));
  });
  const rank = (entry: DesktopEntry) =>
    (entry.id === `${path.basename(runs(entry) ?? "")}.desktop` ? 0 : 2) +
    (entry.keys.get("NoDisplay") === "true" ? 1 : 0);
  return matching.sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Gets Chromium-engine apps onto the accessibility bus on Linux. Such an app shares its windows
 * only when it starts with a variable and an option set, so with the user's consent Rakazo hides
 * its launcher entry behind one that starts it that way. The user restarts the app themselves,
 * so nothing unsaved is lost.
 */
export function createAppAccessibility(deps: {
  dirs: LauncherDirs;
  processes: () => Promise<UserProcess[]>;
  selfPid: number;
  /** Asks the user on this computer; true means they allowed it. */
  ask: (name: string) => Promise<boolean>;
  /** Tells the user a change they allowed couldn't be made. */
  failed: (name: string, error: unknown) => void;
}) {
  // Until Rakazo restarts, a "Not Now" stands and a question already showing isn't asked again.
  const declined = new Set<string>();
  const asking = new Set<string>();

  // Writing, removing and refreshing entries take turns, so a removal is never undone.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = turn.then(work, work);
    // The next turn waits for this one however it ends; its caller still sees a failure.
    turn = Promise.allSettled([next]);
    return next;
  };

  async function allow(entry: DesktopEntry, name: string) {
    try {
      if (!(await deps.ask(name))) declined.add(entry.id);
      // The user may have made their own entry while the question was open.
      else
        await inTurn(async () => {
          if (!(await launcherOwner(entry.id, deps.dirs))) await writeLauncher(entry, deps.dirs);
        });
    } catch (error) {
      deps.failed(name, error);
    } finally {
      asking.delete(entry.id);
    }
  }

  return {
    /** The programs the launcher entries named `app` run. */
    async aliases(app: string) {
      return entryPrograms(app, await readDesktopEntries([deps.dirs.user, ...deps.dirs.system]));
    },

    /** What to tell the bot about `app`, open but off the bus; `fallback` when Rakazo can't help. */
    async explain(app: string, fallback: string): Promise<string> {
      const found = inspectApp(app, await deps.processes(), deps.selfPid);
      if (found?.self) return "Rakazo can't use its own window.";
      if (!found?.engine) return fallback;
      const entry = launcherEntry(found.launchers, await readDesktopEntries(deps.dirs.system));
      if (!entry || !canWriteLauncher(entry, deps.dirs)) return fallback;
      const name = entry.keys.get("Name") || app;
      const owner = await launcherOwner(entry.id, deps.dirs);
      if (owner === "user")
        return `${name} has a launcher entry the user made, so Rakazo leaves it alone. Ask the user to make it start ${name} with ACCESSIBILITY_ENABLED=1 set and the ${SHARING_OPTION} option, then quit and reopen ${name}.`;
      // The option alone doesn't put an app on the bus; only Rakazo's launcher sets both.
      if (owner === "rakazo")
        return found.sharing
          ? `${name} was started for screen control but still doesn't share its window. Ask the user to quit ${name} completely and open it again from their app launcher.`
          : `${name} is set up for screen control but is still running from before. Ask the user to quit ${name} completely and open it again.`;
      if (declined.has(entry.id))
        return `The user chose not to set ${name} up for screen control for now.`;
      if (!asking.has(entry.id)) {
        asking.add(entry.id);
        void allow(entry, name);
      }
      return `Rakazo is asking the user on their computer whether bots may use ${name}. Ask them to answer it; if they allow it, they then need to quit ${name} completely and open it again.`;
    },

    /** Removes every launcher entry Rakazo wrote. */
    remove: () => inTurn(() => removeLaunchers(deps.dirs)),
    /** Keeps Rakazo's entries in step with app updates and removals. */
    refresh: () => inTurn(() => refreshLaunchers(deps.dirs)),
  };
}

export type AppAccessibility = ReturnType<typeof createAppAccessibility>;
