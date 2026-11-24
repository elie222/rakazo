import { sandboxKindCapabilities } from "../../../computers/sandbox/sandbox-kind-capabilities.js";

export { desktopGuardRefusalMessage } from "./desktop-command-guard.prompt.js";

// Processes of the shared desktop: the browser, the display, its window manager, the viewer, and
// the session bus and portal the browser's file chooser uses.
const SHARED_PROCESS =
  /chrom|brave|rakazo-browser|xvfb|x11vnc|websockify|novnc|fluxbox|dbus-daemon|xdg-desktop-portal/;
const KILL = /^(?:pkill|killall|kill)$/;
// The shared browser profiles and the display's socket and lock files.
const SHARED_PATH = /\.browser-profiles|\/tmp\/\.x11-unix|\/tmp\/\.x\d+-lock/;
const CHANGE =
  /^(?:rm|rmdir|unlink|mv|cp|rsync|dd|tee|ln|shred|truncate|install|chmod|chown|-delete)$/;

/**
 * Short reason the command would reach beyond the bot's own work on a shared computer, when it
 * would. A literal check for honest mistakes: it matches words anywhere in the command, so a
 * loop, `bash -c` or `sudo` wrapper is still caught, and any other shell syntax runs. A command
 * that hides what it does is not looked into.
 */
export function protectedComputerLifecycleRefusal(command: string): string | undefined {
  const text = command.toLowerCase().replaceAll(/[\\'"]/g, "");
  const words = text.split(/[\s;&|()<>`$={}]+/).filter(Boolean);
  const names = words.map((word) => word.split("/").at(-1) ?? "");
  if (names.includes("killall5") || names.includes("xkill")) return "kill of every process";
  const kill = names.find((name) => KILL.test(name));
  // kill -9 -1 and pkill -u name reach every process of this user, the shared desktop included.
  if (kill && (names.includes("-1") || names.includes("-u"))) return "kill of every process";
  if (kill && words.some((word) => SHARED_PROCESS.test(word))) return `${kill} of a shared process`;
  const service = names.find((name) => name === "systemctl" || name === "service");
  if (service && names.some((name) => /^(?:stop|restart|kill)$/.test(name))) {
    return `${service} stop or restart`;
  }
  const sharedPath = words.some((word) => SHARED_PATH.test(word));
  const redirected =
    />\s*[^\s;&|]*(?:\.browser-profiles|\/tmp\/\.x11-unix|\/tmp\/\.x\d+-lock)/.test(text);
  if (redirected || (sharedPath && names.some((name) => CHANGE.test(name)))) {
    return "change to a shared file";
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
