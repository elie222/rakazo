import { sandboxKindCapabilities } from "../../../computers/sandbox/sandbox-kind-capabilities.js";

export { desktopGuardRefusalMessage } from "./desktop-command-guard.prompt.js";

// Processes of the shared desktop: the browser, the display, its window manager and the viewer.
const SHARED_PROCESS = /chrom|rakazo-browser|xvfb|x11vnc|websockify|novnc|fluxbox/;
const KILL_BY_NAME = /^(?:pkill|killall|kill)$/;
const SERVICE_ACTION = /^(?:stop|restart|kill)$/;
// The shared browser profiles and the display's socket and lock files.
const SHARED_PATH = /\.browser-profiles|\/tmp\/\.x11-unix|\/tmp\/\.x\d+-lock/;
const DELETE_OR_WRITE =
  /^(?:rm|rmdir|unlink|mv|cp|rsync|dd|tee|ln|shred|truncate|install)$|^-delete$|^of=/;

/**
 * Short reason the command would reach beyond the bot's own work on a shared computer, when it
 * would. A literal check for honest mistakes: any other shell syntax runs, and a command that
 * hides what it does is not looked into.
 */
export function protectedComputerLifecycleRefusal(command: string): string | undefined {
  const words = command
    .toLowerCase()
    .replaceAll(/[\\'"]/g, "")
    .split(/[\s;&|()<>`$]+/)
    .filter(Boolean);
  const names = words.map((word) => word.split("/").at(-1) ?? "");
  if (names.includes("killall5")) return "killall5";
  const kill = names.find((name) => KILL_BY_NAME.test(name));
  if (kill && words.some((word) => SHARED_PROCESS.test(word))) return `${kill} of a shared process`;
  const service = names.find((name) => name === "systemctl" || name === "service");
  if (service && names.some((name) => SERVICE_ACTION.test(name)))
    return `${service} stop or restart`;
  if (words.some((word) => SHARED_PATH.test(word)) && words.some((w) => DELETE_OR_WRITE.test(w))) {
    return "change to the shared browser profile or display";
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
