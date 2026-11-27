import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pollUntil } from "@rakazo/core/retry";
import type { HostScreen, HostScreenAction, HostScreenObservation } from "./host-screen.js";
import {
  actThenObserve,
  boundedHostScreenTree,
  HOST_SCREEN_MAX_ELEMENTS,
  HOST_SCREEN_MAX_IMAGE_DIMENSION,
  HostScreenError,
} from "./host-screen.js";

/** The JSON envelope every agent-desktop command prints. */
export interface AgentDesktopEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message?: string; disposition?: { retry?: string } };
}

/** Runs one agent-desktop command to completion and returns its envelope. */
export type AgentDesktopRun = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<AgentDesktopEnvelope>;

/** The operating system the CLI drives, as the bot reads it. */
export type AgentDesktopSystem = "Windows" | "Linux";

export interface AgentDesktopHostScreenOptions {
  run: AgentDesktopRun;
  system: AgentDesktopSystem;
  /**
   * Linux only: whether a process with this name runs, so an app that is open but off the
   * accessibility bus is reported instead of launched again.
   */
  running?: (app: string) => Promise<boolean>;
  /**
   * Linux only: the program names an app's windows carry when the bot names it another way, such
   * as "Files" for the program its launcher runs.
   */
  aliases?: (app: string) => Promise<string[]>;
  /**
   * Linux only: what to tell the bot about an app that is open but off the accessibility bus,
   * given the program running it and the message it would hear otherwise.
   */
  unreadable?: (app: string, message: string) => Promise<string>;
  /**
   * Linux only: the ids of the app's processes. An app on a shared runtime lists its windows
   * under the runtime's name, so only its process ties them to it.
   */
  processIds?: (app: string) => Promise<number[]>;
  /** This app's own process. Driving it could answer its own approval cards. */
  selfPid: number;
  /** Shrinks a PNG so its long edge is at most `maxDimension`. */
  fitImage?: (
    png: Buffer,
    maxDimension: number,
  ) => { png: Buffer; width: number; height: number } | undefined;
}

export const SCREEN_DRIVER_BLOCKED_MESSAGE =
  "Windows stopped screen control from starting on this computer. Security settings such as Smart App Control can block it; ask the user to check them.";
const SCREEN_DRIVER_FAILED_MESSAGE = "Screen control couldn't start on this computer.";

// Linux apps are read over the desktop session's accessibility bus and display.
const LINUX_SESSION_ENVIRONMENT = [
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "XAUTHORITY",
] as const;

interface AgentDesktopWindow {
  id: string;
  title?: string;
  app_name: string;
  pid: number;
  accessible?: boolean;
  minimized?: boolean;
  visible?: boolean;
}

interface AgentDesktopNode {
  ref_id?: string;
  role?: string;
  name?: string;
  value?: string;
  states?: string[];
  subtree_truncated?: boolean;
  children?: AgentDesktopNode[];
}

interface Target {
  name: string;
  windowId: string;
  title?: string;
}

const LAUNCH_WAIT_MS = 4_000;
const OBSERVE_TIMEOUT_MS = "8000";
const REF = /^@([^:\s]+):e(\d+)$/;
// Windows and Linux call the primary shortcut modifier ctrl; cmd there is the Windows or Super key.
const MODIFIERS = { cmd: "ctrl", ctrl: "ctrl", option: "alt", shift: "shift" } as const;

/** A command the CLI refused, with whether it may already have taken effect. */
class AgentDesktopError extends HostScreenError {
  constructor(
    message: string,
    readonly code: string,
    readonly notDelivered: boolean,
  ) {
    super(message);
  }
}

/**
 * Runs agent-desktop as this app's child, one process per command. Its state root stays apart
 * from any standalone install, and it reads only the environment it needs.
 */
export function agentDesktopCli(options: {
  /** Resolves to the executable, fetching it first if needed. */
  command: () => Promise<string>;
  home: string;
  system: AgentDesktopSystem;
}): AgentDesktopRun {
  const session =
    options.system === "Linux"
      ? Object.fromEntries(
          LINUX_SESSION_ENVIRONMENT.flatMap((name) =>
            process.env[name] ? [[name, process.env[name]]] : [],
          ),
        )
      : {};
  return async (args, signal) => {
    const command = await options.command();
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          env: { ...getDefaultEnvironment(), ...session, AGENT_DESKTOP_HOME: options.home },
          signal,
          timeout: 60_000,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (signal.aborted) return reject(signal.reason);
          const envelope = parseEnvelope(stdout);
          if (envelope) return resolve(envelope);
          reject(
            error?.syscall?.startsWith("spawn")
              ? new HostScreenError(
                  options.system === "Windows"
                    ? SCREEN_DRIVER_BLOCKED_MESSAGE
                    : SCREEN_DRIVER_FAILED_MESSAGE,
                )
              : (error ?? new Error("no envelope")),
          );
        },
      );
    });
  };
}

function parseEnvelope(stdout: string): AgentDesktopEnvelope | undefined {
  try {
    const value = JSON.parse(stdout) as AgentDesktopEnvelope;
    return typeof value?.ok === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Windows and Linux screen control over agent-desktop's CLI, which reads UI Automation on Windows
 * and the AT-SPI accessibility bus on Linux. Every action is headless: it
 * never moves the pointer, types through the keyboard, or brings a window forward, so gestures
 * that only exist as physical input are refused with a way around them.
 */
export function createAgentDesktopHostScreen(options: AgentDesktopHostScreenOptions): HostScreen {
  const { system } = options;
  const close = new AbortController();
  // The latest snapshot per window: element numbers in actions refer to it.
  const snapshots = new Map<string, string>();

  async function call(app: string, args: string[], signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const both = AbortSignal.any([signal, close.signal]);
    let envelope: AgentDesktopEnvelope;
    try {
      envelope = await options.run(args, both);
    } catch (error) {
      if (signal.aborted || error instanceof HostScreenError) throw error;
      throw new HostScreenError("Screen control stopped responding. Try again.");
    }
    if (envelope.ok) return envelope.data;
    const code = envelope.error?.code ?? "INTERNAL";
    const retry = envelope.error?.disposition?.retry;
    const message = refusal(system, app, code, envelope.error?.message);
    throw new AgentDesktopError(
      retry && retry !== "safe"
        ? `${message} It may have taken effect; check before repeating it.`
        : message,
      code,
      retry === "safe",
    );
  }

  async function listWindows(query: string, signal: AbortSignal): Promise<AgentDesktopWindow[]> {
    const windows = await call(query, ["list-windows"], signal);
    return Array.isArray(windows)
      ? (windows as AgentDesktopWindow[]).filter((window) => window?.id && window.app_name)
      : [];
  }

  /** Only the exact program the user approved, with or without .exe; a near name could be another app. */
  function named(windows: AgentDesktopWindow[], names: string[]) {
    const wanted = names.map((name) => name.trim().toLowerCase());
    return windows.filter((window) => {
      const name = window.app_name.toLowerCase();
      return wanted.some((one) => name === one || name === `${one}.exe`);
    });
  }

  /** The name the bot gave, then the programs its launcher entries run. */
  async function namesFor(query: string) {
    const aliases = options.aliases ? await options.aliases(query) : [];
    return [...new Set([query.trim(), ...aliases])];
  }

  function notOpen(windows: AgentDesktopWindow[], query: string) {
    const wanted = query.trim().toLowerCase();
    const near = [
      ...new Set(
        windows
          .map((window) => appName(window))
          .filter((name) => name.toLowerCase().includes(wanted)),
      ),
    ].slice(0, 3);
    return new HostScreenError(
      near.length
        ? `No open app is named exactly "${query}". Open apps with similar names: ${near.join(", ")}.`
        : `No app named "${query}" is open. Ask the user to open it, then try again.`,
    );
  }

  function windowsWithin(query: string, names: string[], ms: number, signal: AbortSignal) {
    return pollUntil(
      async () => {
        const matching = named(await listWindows(query, signal), names);
        return matching.length > 0 && matching;
      },
      { intervalMs: 400, timeoutMs: ms, signal, onTimeout: (): AgentDesktopWindow[] => [] },
    );
  }

  async function target(query: string, signal: AbortSignal): Promise<Target> {
    const windows = await listWindows(query, signal);
    let matching = named(windows, [query]);
    // Launcher names are read only when the bot's own name finds nothing.
    const names = matching.length ? [query] : await namesFor(query);
    if (!matching.length) matching = named(windows, names);
    const byProcess = !matching.length && options.processIds !== undefined;
    if (byProcess && options.processIds) {
      const { processIds } = options;
      const ids = new Set((await Promise.all(names.map((name) => processIds(name)))).flat());
      matching = windows.filter((window) => ids.has(window.pid));
    }
    if (!matching.length) {
      // An app running off the accessibility bus has no windows to list, and launching it
      // again would open a second window of a single-instance app.
      await refuseUnreadable(query, names, signal);
      // Windows launches only programs it can find by bare name, like notepad.
      const launched = await call(query, ["launch", "--", query], signal).catch((error) => {
        if (!(error instanceof HostScreenError)) throw error;
      });
      if (!launched) throw notOpen(windows, query);
      matching = await windowsWithin(query, names, LAUNCH_WAIT_MS, signal);
    }
    if (matching.some((window) => window.pid === options.selfPid))
      throw new HostScreenError("Rakazo can't use its own window.");
    const usable = matching.filter(
      (window) => window.accessible !== false && window.visible !== false,
    );
    // The list runs front to back, so the first restored window is the one the user sees.
    const window = usable.find((window) => !window.minimized);
    const name = matching[0] && !byProcess ? appName(matching[0]) : query;
    if (!window)
      throw new HostScreenError(
        usable.length
          ? `${name} is minimized. Ask the user to restore its window, then try again.`
          : `${name} is open but shows no window. Ask the user to open one, then try again.`,
      );
    return { name, windowId: window.id, ...(window.title ? { title: window.title } : {}) };
  }

  async function refuseUnreadable(query: string, names: string[], signal: AbortSignal) {
    const { running } = options;
    if (!running) return;
    let app: string | undefined;
    for (const name of names) if (!app && (await running(name))) app = name;
    if (!app) return;
    try {
      // On the bus with no window yet: launching it opens one.
      await call(query, ["snapshot", "--app", app, "--max-depth", "1"], signal);
      return;
    } catch (error) {
      // On the bus with no window: launching it opens one.
      if (error instanceof AgentDesktopError && error.code === "WINDOW_NOT_FOUND") return;
      // Any other refusal says something else about the app, so the bot hears it as it is.
      if (!(error instanceof AgentDesktopError) || error.code !== "APP_NOT_FOUND") throw error;
    }
    const message = `${query} is open but doesn't share its window with screen control. If it's a web browser or a desktop app built on one, ask the user to quit it and start it again with ACCESSIBILITY_ENABLED=1 set and the --force-renderer-accessibility option.`;
    throw new HostScreenError(
      options.unreadable ? await options.unreadable(app, message) : message,
    );
  }

  async function rows(found: Target, signal: AbortSignal, query?: string) {
    const scope = ["--window-id", found.windowId, "--timeout-ms", OBSERVE_TIMEOUT_MS];
    const data = (await call(
      found.name,
      query
        ? ["find", ...scope, `--text=${query}`, "--limit", String(HOST_SCREEN_MAX_ELEMENTS)]
        : ["snapshot", ...scope, "--compact", "--max-depth", "40"],
      signal,
    )) as {
      snapshot_id?: string;
      complete?: boolean;
      tree?: AgentDesktopNode;
      matches?: AgentDesktopNode[];
      window?: { title?: string };
    } | null;
    const snapshot = typeof data?.snapshot_id === "string" ? data.snapshot_id : "";
    if (snapshot) snapshots.set(found.windowId, snapshot);
    else snapshots.delete(found.windowId);
    const lines: string[] = [];
    let truncated = data?.complete === false;
    const visit = (node: AgentDesktopNode, depth: number, root = false) => {
      if (lines.length >= HOST_SCREEN_MAX_ELEMENTS) {
        truncated = true;
        return;
      }
      if (node.subtree_truncated) truncated = true;
      // Toolkits nest many unnamed wrappers (GTK draws about twenty for each row of a file list);
      // listing them spends the row cap before panes later in the window are reached.
      const shown = root || Boolean(node.name || node.value || elementNumber(node, snapshot));
      if (shown) lines.push(`${"  ".repeat(depth)}- ${row(node, snapshot)}`);
      for (const child of node.children ?? []) visit(child, shown ? depth + 1 : depth);
    };
    if (data?.tree) visit(data.tree, 0, true);
    for (const match of data?.matches ?? []) visit({ ...match, children: [] }, 0);
    return {
      tree: boundedHostScreenTree(lines.join("\n"), truncated),
      title: data?.window?.title || found.title,
    };
  }

  async function screenshot(found: Target, signal: AbortSignal) {
    const data = (await call(
      found.name,
      ["screenshot", "--window-id", found.windowId],
      signal,
    )) as {
      data?: string;
      format?: string;
      width?: number;
      height?: number;
    } | null;
    if (!data?.data || data.format !== "png" || !data.width || !data.height) return undefined;
    const png = Buffer.from(data.data, "base64");
    const fitted =
      Math.max(data.width, data.height) > HOST_SCREEN_MAX_IMAGE_DIMENSION && options.fitImage
        ? options.fitImage(png, HOST_SCREEN_MAX_IMAGE_DIMENSION)
        : { png, width: data.width, height: data.height };
    return (
      fitted && {
        mimeType: "image/png" as const,
        data: fitted.png.toString("base64"),
        width: fitted.width,
        height: fitted.height,
      }
    );
  }

  async function observeTarget(
    found: Target,
    signal: AbortSignal,
    query?: string,
  ): Promise<HostScreenObservation> {
    const [{ tree, title }, image] = await Promise.all([
      rows(found, signal, query),
      // The tree is what bots act on; a window that refuses capture still has one.
      screenshot(found, signal).catch((error) => {
        if (!(error instanceof HostScreenError)) throw error;
      }),
    ]);
    return { app: found.name, ...(title ? { title } : {}), tree, ...(image ? { image } : {}) };
  }

  function ref(found: Target, element: number) {
    const snapshot = snapshots.get(found.windowId);
    if (!snapshot) throw new HostScreenError(`Observe ${found.name} before using element numbers.`);
    return `@${snapshot}:e${element}`;
  }

  async function perform(found: Target, action: HostScreenAction, signal: AbortSignal) {
    const run = (...args: string[]) => call(found.name, args, signal);
    switch (action.kind) {
      case "click":
        if (action.element === undefined)
          throw new HostScreenError(
            `On ${system}, click an element number; clicking a point would move the user's pointer.`,
          );
        if (action.double || action.button === "right")
          throw new HostScreenError(
            `On ${system}, double and right clicks would move the user's pointer. Click the element, or use set or menu instead.`,
          );
        try {
          await run("click", "--", ref(found, action.element));
        } catch (error) {
          // A GTK4 list row has no press action, so only the pointer could choose it.
          if (!(error instanceof AgentDesktopError) || error.code !== "POLICY_DENIED") throw error;
          throw new HostScreenError(
            `${found.name} only takes a click on element ${action.element} from the user's pointer. ${
              error.notDelivered
                ? "Look for another control that does the same thing, such as a button, a menu item, or a field to set."
                : "It may have taken effect; check before trying another control."
            }`,
          );
        }
        return;
      case "type":
        throw new HostScreenError(
          `On ${system}, type would take over the user's keyboard. Use set with the field's whole new text instead.`,
        );
      case "set": {
        const element = ref(found, action.element);
        try {
          await run("set-value", "--", element, action.value);
        } catch (error) {
          // A pop-up or list takes its choice by name rather than as a value.
          if (
            !(error instanceof AgentDesktopError) ||
            error.code !== "ACTION_NOT_SUPPORTED" ||
            !error.notDelivered
          )
            throw error;
          await run("select", "--", element, action.value);
        }
        return;
      }
      case "key": {
        if (action.element !== undefined)
          throw new HostScreenError(
            `On ${system}, keys go to whichever element has focus. Leave out element, or use set or click instead.`,
          );
        const key = action.key.length === 1 ? action.key.toLowerCase() : action.key;
        const modifiers = [...new Set((action.modifiers ?? []).map((name) => MODIFIERS[name]))];
        await run("press", "--window-id", found.windowId, "--", [...modifiers, key].join("+"));
        return;
      }
      case "scroll": {
        if (action.element === undefined && action.x !== undefined)
          throw new HostScreenError(
            `On ${system}, scroll an element number; scrolling at a point would move the user's pointer.`,
          );
        const area =
          action.element !== undefined
            ? ref(found, action.element)
            : await first(run, ["find", "--window-id", found.windowId, "--role", "scrollarea"]);
        if (!area) throw new HostScreenError(`Nothing in ${found.name} scrolls.`);
        await run(
          "scroll",
          "--direction",
          action.direction,
          "--amount",
          String(action.amount ?? 3),
          "--",
          area,
        );
        return;
      }
      case "menu": {
        const [top, ...items] = action.path;
        const scope = ["--window-id", found.windowId];
        let item = await first(run, [
          "find",
          ...scope,
          "--role",
          "menuitem",
          `--name=${top}`,
          "--exact",
        ]);
        for (const name of items) {
          if (!item) break;
          await run("click", "--", item);
          item = await first(run, [
            "find",
            ...scope,
            "--surface",
            "menu",
            `--name=${name}`,
            "--exact",
          ]);
        }
        if (!item)
          throw new HostScreenError(`${found.name} has no menu item ${action.path.join(" > ")}.`);
        await run("click", "--", item);
        return;
      }
      case "wait":
        await sleep(action.ms, undefined, { signal });
        return;
    }
  }

  return {
    async observe(scope, app, observeOptions) {
      return observeTarget(await target(app, scope.signal), scope.signal, observeOptions?.query);
    },
    act(scope, app, actions) {
      // Find the window again each time: the last action may have closed it or opened another.
      return actThenObserve(
        scope.signal,
        actions,
        async (action) => perform(await target(app, scope.signal), action, scope.signal),
        async () => observeTarget(await target(app, scope.signal), scope.signal),
      );
    },
    async close() {
      close.abort();
    },
  };
}

/** The first match's element, or undefined when nothing matches. */
async function first(run: (...args: string[]) => Promise<unknown>, args: string[]) {
  const data = (await run(...args, "--first")) as { match?: AgentDesktopNode | null } | null;
  return data?.match?.ref_id;
}

function appName(window: AgentDesktopWindow) {
  return window.app_name.replace(/\.exe$/i, "");
}

/** The number the bot uses for an element of this snapshot, if it can act on it. */
function elementNumber(node: AgentDesktopNode, snapshot: string) {
  const match = node.ref_id ? REF.exec(node.ref_id) : null;
  return match && match[1] === snapshot ? match[2] : undefined;
}

function row(node: AgentDesktopNode, snapshot: string) {
  const element = elementNumber(node, snapshot);
  const parts = [
    ...(element ? [`[${element}]`] : []),
    node.role || "element",
    ...(node.name ? [JSON.stringify(node.name)] : []),
    ...(node.value && node.value !== node.name ? [`= ${JSON.stringify(node.value)}`] : []),
    ...(node.states?.length ? [`(${node.states.join(", ")})`] : []),
  ];
  return parts.join(" ");
}

/** What a refused command means for the bot, without the CLI's internals or file paths. */
function refusal(
  system: AgentDesktopSystem,
  app: string,
  code: string,
  message: string | undefined,
) {
  switch (code) {
    case "STALE_REF":
    case "SNAPSHOT_NOT_FOUND":
    case "ELEMENT_NOT_FOUND":
    case "AMBIGUOUS_TARGET":
      return `${app} changed since the last observation. Observe it again and use the new element numbers.`;
    case "POLICY_DENIED":
      return `${system} won't send that to ${app} without taking over the user's pointer or keyboard. Use click, set, or menu instead.`;
    case "PERM_DENIED":
      return system === "Windows"
        ? `Windows doesn't let Rakazo use ${app}, usually because it runs as administrator.`
        : `${system} doesn't let Rakazo use ${app}.`;
    case "APP_UNRESPONSIVE":
      return `${app} is not responding.`;
    case "TIMEOUT":
      return `${app} didn't respond in time. The element may be disabled or still loading.`;
    case "APP_NOT_FOUND":
    case "WINDOW_NOT_FOUND":
      return `${app}'s window closed.`;
    case "ACTION_FAILED":
    case "ACTION_NOT_SUPPORTED":
    case "INVALID_ARGS":
      return message || "That element can't do that.";
    case "PLATFORM_NOT_SUPPORTED":
      if (system === "Linux")
        return "Screen control can't reach this computer's accessibility service. Ask the user to check that accessibility is turned on in their desktop session.";
      return "Screen control failed. Try again.";
    default:
      return "Screen control failed. Try again.";
  }
}
