import {
  BROWSER_APPLICATIONS as DOCKER_BROWSER_ALIASES,
  shellQuote,
  stopAllDesktopBrowsersCommand,
  stopBrowserCommand,
  stopExtraScreenCommand,
  stopScreenTransportsCommand,
} from "@rakazo/core/node/desktop-runtime";

export {
  browserProfilePathForScreen,
  ensureScreenCommand,
  interactiveScreenCommand,
  prepareBrowserProfileCommand,
  stopBrowserCommand,
  stopExtraScreenCommand,
} from "@rakazo/core/node/desktop-runtime";

import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { canReleaseScreenLease, canTakeScreenLease } from "@rakazo/core";
import { z } from "zod";
import { type SandboxInput, TEAM_SCREEN_LIMIT, xdotoolCommand } from "./computer-spec.js";

export const computerActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), key: z.string(), modifiers: z.array(z.string()).optional() }),
  z.object({
    kind: z.literal("pointer"),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right"]).optional(),
    type: z.enum(["move", "down", "up", "click"]),
  }),
  z.object({ kind: z.literal("clipboard"), text: z.string() }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().optional(),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number() }),
  z.object({ kind: z.literal("open"), path: z.string() }),
  z.object({ kind: z.literal("launch"), application: z.string(), uri: z.string().optional() }),
]);

export { BROWSER_APPLICATIONS as DOCKER_BROWSER_ALIASES } from "@rakazo/core/node/desktop-runtime";

export function assertRequestIdentity(
  botId: string | undefined,
  spaceId: string | undefined,
  expected: { botId: string; spaceId: string },
) {
  if (botId !== expected.botId || spaceId !== expected.spaceId) {
    throw new Error("computer identity mismatch");
  }
}

export function hasComputerIdentity(
  labels: Record<string, string> | undefined,
  botId: string,
  spaceId: string,
) {
  const labeledSpaceId = labels?.["rakazo.spaceId"] ?? labels?.["rakazo.workspaceId"];
  return labels?.["rakazo.botId"] === botId && labeledSpaceId === spaceId;
}

export function hasValidBearerToken(authorization: string | undefined, expectedToken: string) {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const actual = Buffer.from(expectedToken);
  const candidate = Buffer.from(supplied);
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

/** Prefer the HTTP control fast path; on failure use the docker-exec fallback. */
export async function preferComputerControl<T>(
  run: (() => Promise<T>) | undefined,
  fallback: () => Promise<T>,
): Promise<T> {
  if (!run) return fallback();
  try {
    return await run();
  } catch {
    return fallback();
  }
}

export class ComputerControlUnavailableError extends Error {
  constructor(message = "computer control unavailable") {
    super(message);
    this.name = "ComputerControlUnavailableError";
  }
}

function errorText(error: unknown) {
  if (!(error instanceof Error)) return String(error).toLowerCase();
  const cause = error.cause instanceof Error ? ` ${error.cause.message}` : "";
  return `${error.message}${cause}`.toLowerCase();
}

/** True when the control service was never reached, so actions were not applied. */
export function isComputerControlUnavailable(error: unknown) {
  if (error instanceof ComputerControlUnavailableError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return false;
  const text = errorText(error);
  // Only pre-connect failures prove no actions ran. Mid-flight resets/hang-ups can
  // happen after the service already applied steps.
  return (
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("ehostunreach") ||
    text.includes("enetunreach") ||
    text.includes("eai_again")
  );
}

export type ComputerControlAttempt<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable" }
  | { status: "failed"; error: Error };

/**
 * Try the HTTP control fast path.
 * `unavailable` means the service was never reached (safe to fall back for actions).
 * `failed` means the request may have partially applied actions (do not replay).
 */
export async function attemptComputerControl<T>(
  run: (() => Promise<T>) | undefined,
): Promise<ComputerControlAttempt<T>> {
  if (!run) return { status: "unavailable" };
  try {
    return { status: "ok", value: await run() };
  } catch (error) {
    if (isComputerControlUnavailable(error)) return { status: "unavailable" };
    return {
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Replay actions via docker-exec only when control was never reached. */
export function shouldReplayComputerActions(attempt: ComputerControlAttempt<unknown>) {
  return attempt.status === "unavailable";
}

const CONTROL_BASE_TIMEOUT_MS = 15_000;
const CONTROL_MAX_TIMEOUT_MS = 60_000;

/** Bound the HTTP control deadline by mapped waits and settle time. */
export function computerControlTimeoutMs(
  actions: Array<z.infer<typeof computerActionSchema>>,
  settleMs = 0,
) {
  let waits = 0;
  for (const action of actions) {
    if (action.kind === "wait") waits += Math.min(Math.max(action.ms, 0), 5_000);
  }
  return Math.min(
    CONTROL_MAX_TIMEOUT_MS,
    CONTROL_BASE_TIMEOUT_MS + waits + Math.min(Math.max(settleMs, 0), 5_000),
  );
}

export function toSandboxInput(input: {
  kind: "key" | "pointer" | "clipboard";
  key?: string;
  modifiers?: string[];
  x?: number;
  y?: number;
  button?: "left" | "right";
  type?: "move" | "down" | "up" | "click";
  text?: string;
}): SandboxInput {
  if (input.kind === "key") {
    return { kind: "key", key: input.key ?? "", modifiers: input.modifiers };
  }
  if (input.kind === "clipboard") return { kind: "clipboard", text: input.text ?? "" };
  return {
    kind: "pointer",
    x: input.x ?? 0,
    y: input.y ?? 0,
    button: input.button,
    type: input.type ?? "click",
  };
}

export function nextScreenIndex(
  assigned: Map<string, ScreenAssignment>,
  screenId: string,
  leaseId?: string,
  limit = TEAM_SCREEN_LIMIT,
): number {
  const existing = assigned.get(screenId);
  if (existing) {
    if (existing.releasing) {
      throw new Error("This Team Computer screen is still being released.");
    }
    if (leaseId) {
      if (
        existing.leaseId &&
        existing.leaseId !== leaseId &&
        !canTakeScreenLease(existing.leaseId, leaseId)
      ) {
        throw new Error("This Team Computer screen is owned by a newer execution.");
      }
      if (canTakeScreenLease(existing.leaseId, leaseId)) existing.leaseId = leaseId;
    }
    return existing.index;
  }
  const used = new Set([...assigned.values()].map((slot) => slot.index));
  for (let index = 0; index < limit; index += 1) {
    if (!used.has(index)) {
      assigned.set(screenId, { index, leaseId });
      return index;
    }
  }
  throw new Error(`This Team Computer cannot allocate another screen (limit ${limit}).`);
}

export function releaseAssignedScreen(
  assigned: Map<string, ScreenAssignment>,
  screenId: string,
  leaseId?: string,
): number | undefined {
  const slot = assigned.get(screenId);
  if (!slot || (leaseId && !canReleaseScreenLease(slot.leaseId, leaseId))) {
    return undefined;
  }
  if (slot.releasing) return slot.index;
  slot.releasing = true;
  return slot.index;
}

export function completeReleasedScreen(
  assigned: Map<string, ScreenAssignment>,
  screenId: string,
  index: number,
): void {
  const slot = assigned.get(screenId);
  if (slot?.releasing && slot.index === index) assigned.delete(screenId);
}

export async function teardownReleasedScreen(
  assigned: Map<string, ScreenAssignment>,
  screenId: string,
  index: number,
  teardown: () => Promise<{ code: number; stderr: string }>,
) {
  const result = await teardown();
  if (result.code !== 0) throw new Error(result.stderr || "computer screen failed to stop");
  completeReleasedScreen(assigned, screenId, index);
}

export interface ScreenAssignment {
  index: number;
  leaseId?: string;
  releasing?: boolean;
  viewToken?: string;
}

export function clearComputerScreenRegistry(
  registry: Map<string, Map<string, ScreenAssignment>>,
  containerId: string,
) {
  registry.delete(containerId);
}

/** Choose the stop command for DELETE /screen cancel/release.
 * Callers must hold the per-computer screen lock across this decision and any stop. */
export function screenReleaseStopCommand(
  index: number | undefined,
  options: {
    hasRegistry: boolean;
    cancelRunWork: boolean;
    screenId: string;
  },
): string {
  if (index !== undefined) {
    return stopExtraScreenCommand(index, options.screenId);
  }
  // Missing registry after a supervisor restart: cancel still tears down the
  // matching bot's orphaned Chromium process without touching another bot.
  // Present registry + rejected release: newer fence owns the screen — do not kill.
  if (!options.hasRegistry && options.cancelRunWork) {
    return stopBrowserCommand(options.screenId);
  }
  return "";
}

export function stopScreensCommand(screens: Array<{ screenId: string; index: number }>) {
  return [
    "set -eu",
    "failed=0",
    ...screens.map(
      ({ screenId }) => `bash -eu -c ${shellQuote(stopBrowserCommand(screenId))} || failed=1`,
    ),
    '[ "$failed" -eq 0 ] || { echo "computer browser failed to stop" >&2; exit 1; }',
  ].join("\n");
}

export function resetManagedScreensCommand() {
  return [
    "set -eu",
    ...Array.from({ length: TEAM_SCREEN_LIMIT }, (_, index) => stopScreenTransportsCommand(index)),
    stopAllDesktopBrowsersCommand(),
    "pkill -f '^([^ ]*/)?chromium[^ ]* .*--user-data-dir=/home/rakazo/.browser-profiles/' 2>/dev/null || true",
    "for i in $(seq 1 40); do if ! pgrep -f '^([^ ]*/)?chromium[^ ]* .*--user-data-dir=/home/rakazo/.browser-profiles/' >/dev/null; then break; fi; sleep 0.25; done",
    "if pgrep -f '^([^ ]*/)?chromium[^ ]* .*--user-data-dir=/home/rakazo/.browser-profiles/' >/dev/null; then echo 'browser still running' >&2; exit 1; fi",
    "pkill -f '[X]vfb :[2-8] ' 2>/dev/null || true",
    "pkill -f '[f]luxbox -rc /tmp/fluxbox-home-[2-8]/.fluxbox/init' 2>/dev/null || true",
    "rm -f /tmp/rakazo/browser-pid-* /tmp/rakazo/browser-profile-*",
  ].join("\n");
}

export async function withKeyedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
) {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  locks.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export function containerActionStep(
  action: z.infer<typeof computerActionSchema>,
  display = ":1",
  browserProfile?: string,
): { argv: string[] } | { waitMs: number } {
  if (action.kind === "wait") {
    return { waitMs: Math.min(Math.max(action.ms, 0), 5_000) };
  }
  let argv: string[];
  if (action.kind === "key" || action.kind === "pointer" || action.kind === "clipboard") {
    argv = ["env", `DISPLAY=${display}`, ...xdotoolCommand(toSandboxInput(action))];
  } else if (action.kind === "scroll") {
    argv = [
      "env",
      `DISPLAY=${display}`,
      "xdotool",
      "click",
      "--repeat",
      String(Math.min(Math.max(Math.round(action.amount ?? 3), 1), 20)),
      action.direction === "up" ? "4" : "5",
    ];
  } else if (action.kind === "open") {
    const target = /^https?:\/\//i.test(action.path)
      ? action.path
      : workspaceTarget(normalizeWorkspaceRelative(action.path));
    argv = [
      "env",
      `DISPLAY=${display}`,
      ...(browserProfile ? [`RAKAZO_BROWSER_PROFILE=${browserProfile}`] : []),
      "xdg-open",
      target,
    ];
  } else {
    const browser = DOCKER_BROWSER_ALIASES.has(action.application.toLowerCase());
    argv = [
      "env",
      `DISPLAY=${display}`,
      ...(browser && browserProfile ? [`RAKAZO_BROWSER_PROFILE=${browserProfile}`] : []),
      browser ? "rakazo-browser" : action.application,
      ...(action.uri ? [action.uri] : []),
    ];
  }
  return { argv };
}

export function containerActionSteps(
  actions: Array<z.infer<typeof computerActionSchema>>,
  display = ":1",
  browserProfile?: string,
) {
  return actions.map((action) => containerActionStep(action, display, browserProfile));
}

export function normalizeWorkspaceRelative(value: string) {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("path escapes the computer workspace");
  }
  return segments.join("/");
}

export function workspaceTarget(relative: string) {
  return relative ? path.posix.join("/home/rakazo", relative) : "/home/rakazo";
}

export function sandboxTimeoutCommand(argv: string[], timeoutMs: number, completionMarker: string) {
  return [
    "timeout",
    "--kill-after=1s",
    `${timeoutMs / 1_000}s`,
    "sh",
    "-c",
    '"$@"; status=$?; if [ "$status" -eq 124 ]; then : > "$0"; fi; exit "$status"',
    completionMarker,
    ...argv,
  ];
}

export function sandboxCommandTimedOut(exitCode: number, completedWithExit124: boolean) {
  return exitCode === 124 && !completedWithExit124;
}

export function parseObservation(output: string) {
  const geometry = output.match(/^GEOM\s+(\d+)\s+(\d+)$/m);
  const cursorLine = output.match(/^CURSOR\s+(.+)$/m)?.[1] ?? "";
  const cursorX = Number(cursorLine.match(/X=(\d+)/)?.[1]);
  const cursorY = Number(cursorLine.match(/Y=(\d+)/)?.[1]);
  const windowId = output.match(/^WINDOW\s*(.*)$/m)?.[1]?.trim();
  const title = output.match(/^TITLE\s*(.*)$/m)?.[1]?.trim();
  const image = output.match(/^IMAGE\s+([A-Za-z0-9+/=]+)$/m)?.[1];
  if (!image) throw new Error("screen capture returned no image");
  return {
    image,
    mimeType: "image/png" as const,
    width: Number(geometry?.[1] ?? 1280),
    height: Number(geometry?.[2] ?? 800),
    ...(Number.isFinite(cursorX) && Number.isFinite(cursorY)
      ? { cursor: { x: cursorX, y: cursorY } }
      : {}),
    ...(windowId ? { activeWindow: { id: windowId, ...(title ? { title } : {}) } } : {}),
  };
}

/**
 * True when `buffer` is a complete Docker multiplexed stream: every frame has
 * type 0/1/2, its payload fits in the remaining bytes, and parsing ends exactly
 * at the buffer length. Otherwise the buffer is treated as raw (TTY) stdout.
 */
function isCompleteDockerMultiplexedStream(buffer: Buffer): boolean {
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) return false;
    const type = buffer[offset];
    if (type !== 0 && type !== 1 && type !== 2) return false;
    // Bytes 1–3 are reserved padding and must be zero in Docker's multiplex format.
    if (buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 0) {
      return false;
    }
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) return false;
    offset += 8 + size;
  }
  return offset === buffer.length;
}

/**
 * Split a Docker exec stream into stdout and stderr. Without a TTY the stream is
 * multiplexed: each frame is an 8-byte header (type byte, 3 reserved bytes, big-endian
 * length) followed by the payload, and type 2 is stderr. A raw (TTY) stream has no
 * headers and is all stdout. Only demux when the buffer validates as a complete
 * multiplexed sequence; otherwise return the whole buffer as stdout.
 */
export function demuxDockerStream(buffer: Buffer): { stdout: string; stderr: string } {
  if (!isCompleteDockerMultiplexedStream(buffer)) {
    return { stdout: buffer.toString("utf8"), stderr: "" };
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const payload = buffer.subarray(offset + 8, offset + 8 + size);
    (buffer[offset] === 2 ? stderr : stdout).push(payload);
    offset += 8 + size;
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}
