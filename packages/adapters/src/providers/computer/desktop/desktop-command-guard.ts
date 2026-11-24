import { sandboxKindCapabilities } from "../../../computers/sandbox/sandbox-kind-capabilities.js";

export { desktopGuardRefusalMessage } from "./desktop-command-guard.prompt.js";

// Processes of the shared desktop: the browser, the display, its window manager, the viewer, and
// the session bus and portal the browser's file chooser uses.
const SHARED_PROCESS =
  /chrom|rakazo-browser|xvfb|x11vnc|websockify|novnc|fluxbox|dbus-daemon|xdg-desktop-portal/;
const KILL_BY_NAME = new Set(["pkill", "killall", "kill"]);
// The shared browser profiles and the display's socket and lock files.
const SHARED_PATH = /\.browser-profiles|\/tmp\/\.x11-unix|\/tmp\/\.x\d+-lock/;
const DELETE_OR_WRITE = new Set([
  "rm",
  "rmdir",
  "unlink",
  "mv",
  "cp",
  "rsync",
  "dd",
  "tee",
  "ln",
  "shred",
  "truncate",
  "install",
  "chmod",
  "chown",
  "find",
]);
// Words that run the next word as the command.
const PREFIXES = new Set(["sudo", "env", "command", "exec", "nohup", "xargs", "time", "builtin"]);

type SimpleCommand = { words: string[]; redirects: string[] };

/** Simple commands with quotes removed. Quoted text stays one word, so a quoted pattern is data. */
function simpleCommands(command: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [] };
  let word = "";
  let started = false;
  let redirect = false;
  let quote: "'" | '"' | undefined;
  const endWord = () => {
    if (started) (redirect ? current.redirects : current.words).push(word.toLowerCase());
    if (started) redirect = false;
    word = "";
    started = false;
  };
  const endCommand = () => {
    endWord();
    redirect = false;
    if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
    current = { words: [], redirects: [] };
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\") {
      word += command[index + 1] ?? "";
      started = true;
      index += 1;
    } else if (character === ">" || character === "<") {
      endWord();
      redirect = character === ">";
    } else if (/[;&|()`\n]/.test(character) || (character === "$" && command[index + 1] === "(")) {
      endCommand();
    } else if (/\s/.test(character)) endWord();
    else {
      word += character;
      started = true;
    }
  }
  endCommand();
  return commands;
}

/** The program a simple command runs, after prefixes such as sudo and assignments. */
function programIndex(words: readonly string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index] ?? "";
    const name = word.split("/").at(-1) ?? "";
    if (PREFIXES.has(name) || word.startsWith("-") || /^[a-z_][a-z0-9_]*=/.test(word)) index += 1;
    else return index;
  }
  return index;
}

function refusal(
  { words, redirects }: SimpleCommand,
  namesSharedProcess: boolean,
): string | undefined {
  if (redirects.some((target) => SHARED_PATH.test(target))) return "write to a shared file";
  const at = programIndex(words);
  const program = words[at]?.split("/").at(-1) ?? "";
  const args = words.slice(at + 1);
  if (program === "killall5" || program === "xkill") return program;
  if (KILL_BY_NAME.has(program)) {
    // Every process of this user, which includes the shared desktop: kill -9 -1, pkill -u name.
    const byUser = args.some((arg) => /^(?:-u|--user|--euid|--uid)/.test(arg));
    // With -u, the one other word is the user name, so no process name narrows it.
    const unnamed = args.filter((arg) => !arg.startsWith("-")).length <= 1;
    if (program === "kill" ? args.at(-1) === "-1" : byUser && unnamed) {
      return `${program} of every process`;
    }
    if (namesSharedProcess) return `${program} of a shared process`;
  }
  if (
    (program === "systemctl" || program === "service") &&
    args.some((arg) => /^(?:stop|restart|kill)$/.test(arg))
  ) {
    return `${program} stop or restart`;
  }
  if (DELETE_OR_WRITE.has(program) && (program !== "find" || args.includes("-delete"))) {
    if (args.some((arg) => SHARED_PATH.test(arg))) return "change to a shared file";
  }
  return undefined;
}

/**
 * Short reason the command would reach beyond the bot's own work on a shared computer, when it
 * would. A literal check for honest mistakes: any other shell syntax runs, and a command that
 * hides what it does is not looked into.
 */
export function protectedComputerLifecycleRefusal(command: string): string | undefined {
  const commands = simpleCommands(command);
  // `kill $(pgrep chromium)` names its target in another simple command.
  const namesSharedProcess = commands.some(({ words }) =>
    words.some((word) => SHARED_PROCESS.test(word)),
  );
  for (const simple of commands) {
    const reason = refusal(simple, namesSharedProcess);
    if (reason) return reason;
  }
  return undefined;
}

/** Whether commands reach the Linux desktop this guard protects rather than a native shell. */
export function desktopGuardApplies(computer: {
  graphical: boolean;
  stored: { kind: string };
  kind?: string;
  lazy?: { ready?: { kind: string } };
}) {
  if (!computer.graphical) return false;
  // Before the run starts its computer it may reuse the one it has or start the new kind, so
  // guard unless both have a native shell.
  const kinds = computer.lazy?.ready
    ? [computer.lazy.ready.kind]
    : [computer.stored.kind, computer.kind ?? computer.stored.kind];
  return kinds.some((kind) => !sandboxKindCapabilities(kind).nativeShell);
}
