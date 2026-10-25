import { createHash } from "node:crypto";
import path from "node:path";
import type { ComputerAction, ComputerObservation, ComputerRef } from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";

export function toComputerRef(computer: {
  homeKey: string;
  kind: string;
  providerRef: string | null;
}): ComputerRef {
  if (!computer.providerRef) throw new Error("computer provider reference is missing");
  return {
    id: computer.providerRef,
    botId: computer.homeKey,
    kind: computer.kind as ComputerRef["kind"],
    providerRef: computer.providerRef,
  };
}

const EMPTY_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

export function computerObservation(
  image: Uint8Array,
  input: Omit<ComputerObservation, "frameId" | "capturedAt" | "image">,
): ComputerObservation {
  return {
    ...input,
    image,
    frameId: createHash("sha256").update(image).digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}

export function placeholderObservation(label = "ready"): ComputerObservation {
  return computerObservation(EMPTY_PNG, {
    mimeType: "image/png",
    width: 1,
    height: 1,
    activeWindow: { id: "placeholder", title: label },
  });
}

export function applyPlaceholderAction(box: { screen: string }, action: ComputerAction): void {
  if (action.kind === "clipboard") box.screen = action.text;
  else if (action.kind === "open") box.screen = `opened ${action.path}`;
  else if (action.kind === "launch") box.screen = `launched ${action.application}`;
  else if (action.kind === "focus") box.screen = `focused ${action.application}`;
  else box.screen = action.kind;
}

export function boundedComputerActions(actions: readonly ComputerAction[]): ComputerAction[] {
  if (actions.length > 24) throw new Error("computer action batch exceeds 24 actions");
  return [...actions];
}

export function clampRounded(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

export function normalizeWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path escapes the computer workspace");
  }
  return segments.join("/");
}

/**
 * A path under a sandbox's home names the workspace root, the same mapping the provider's
 * command cwd applies: `/home/rakazo/notes/x.md` on a Docker computer is `notes/x.md`, not
 * `home/rakazo/notes/x.md` under the root. Each provider lists the prefixes its cwd mapping
 * strips so `write_file` and the shell land on the same file.
 */
export function normalizeSandboxFilePath(value: string, homePrefixes: readonly string[]): string {
  const portable = value.replace(/\\/g, "/");
  for (const prefix of homePrefixes) {
    if (portable === prefix) return "";
    if (portable.startsWith(`${prefix}/`)) {
      return normalizeWorkspacePath(portable.slice(prefix.length + 1));
    }
  }
  return normalizeWorkspacePath(value);
}

/** `/home/rakazo` is the Docker home; every provider's cwd mapping already strips it. */
const SANDBOX_HOME_PREFIXES = ["/home/rakazo"] as const;

function stripSandboxHomePrefix(value: string): string {
  const portable = value.replace(/\\/g, "/");
  for (const prefix of SANDBOX_HOME_PREFIXES) {
    if (portable === prefix) return "/";
    if (portable.startsWith(`${prefix}/`)) return portable.slice(prefix.length);
  }
  return value;
}

export function workspacePath(root: string, relative: string): string {
  const normalized = normalizeWorkspacePath(relative);
  return normalized ? path.posix.join(root, normalized) : root;
}

export function teamBotWorkspaceDirectory(botId: string): string {
  return path.posix.join("bots", normalizeWorkspacePath(botId));
}

export function resolveBotWorkspacePath(
  scope: ComputerMode,
  botId: string,
  rawPath: string,
): string {
  const requestedPath = expandHomePrefix(rawPath);
  if (scope !== "team") return requestedPath;
  const explicitRootPath = stripVirtualWorkspaceRoot(stripSandboxHomePrefix(requestedPath));
  const normalized = normalizeWorkspacePath(explicitRootPath ?? requestedPath);
  if (explicitRootPath !== null || isTeamRootPath(normalized)) return normalized;
  return path.posix.join(teamBotWorkspaceDirectory(botId), normalized);
}

export function resolveBotWorkspaceCwd(
  scope: ComputerMode,
  botId: string,
  requestedCwd: string | undefined,
): string | undefined {
  if (scope !== "team") return requestedCwd;
  if (!requestedCwd || requestedCwd === ".") return teamBotWorkspaceDirectory(botId);
  if (path.posix.isAbsolute(requestedCwd) || path.win32.isAbsolute(requestedCwd))
    return requestedCwd;
  return resolveBotWorkspacePath(scope, botId, requestedCwd);
}

/** Paths a user may write while controlling this bot: its home, or shared/. */
export function resolveBotUploadPath(
  scope: ComputerMode,
  botId: string,
  requestedPath: string,
): string {
  const stored = resolveBotWorkspacePath(scope, botId, requestedPath);
  if (scope !== "team") return normalizeWorkspacePath(stored);
  const normalized = normalizeWorkspacePath(stored);
  const botDirectory = teamBotWorkspaceDirectory(botId);
  if (
    normalized === botDirectory ||
    normalized.startsWith(`${botDirectory}/`) ||
    normalized === "shared" ||
    normalized.startsWith("shared/")
  ) {
    return normalized;
  }
  throw new Error("Path escapes the bot workspace");
}

export function displayBotWorkspacePath(
  scope: ComputerMode,
  botId: string,
  requestedPath: string,
  storedPath: string,
): string {
  if (scope !== "team" || !isBotRelativeRequest(requestedPath)) return storedPath;
  const normalized = normalizeWorkspacePath(storedPath);
  const botDirectory = teamBotWorkspaceDirectory(botId);
  if (normalized === botDirectory) return "";
  return normalized.startsWith(`${botDirectory}/`)
    ? normalized.slice(botDirectory.length + 1)
    : normalized;
}

function isBotRelativeRequest(value: string): boolean {
  if (stripVirtualWorkspaceRoot(expandHomePrefix(value)) !== null) return false;
  return !isTeamRootPath(normalizeWorkspacePath(value));
}

function isTeamRootPath(value: string): boolean {
  return (
    value === "shared" ||
    value.startsWith("shared/") ||
    value === "bots" ||
    value.startsWith("bots/")
  );
}

// A leading ~ means the workspace root, the same as a leading /.
function expandHomePrefix(value: string): string {
  return value.replace(/^~([\\/]|$)/, (_, separator: string) => separator || "/");
}

function stripVirtualWorkspaceRoot(value: string): string | null {
  const portable = value.replace(/\\/g, "/");
  if (portable === "/") return "";
  return portable.startsWith("/") ? portable.slice(1) : null;
}

export { shellQuote } from "@rakazo/core/node/desktop-runtime";
