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
  requestedPath: string,
): string {
  if (scope !== "team") return requestedPath;
  const explicitRootPath = stripVirtualWorkspaceRoot(requestedPath);
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
  if (requestedCwd.startsWith("/")) return requestedCwd;
  return resolveBotWorkspacePath(scope, botId, requestedCwd);
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
  if (stripVirtualWorkspaceRoot(value) !== null) return false;
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

function stripVirtualWorkspaceRoot(value: string): string | null {
  const portable = value.replace(/\\/g, "/");
  if (portable === "/") return "";
  return portable.startsWith("/") ? portable.slice(1) : null;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
