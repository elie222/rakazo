import type { DesktopSetup } from "@rakazo/contracts";

/** Where `pnpm dev` serves the Rakazo web app on this machine. */
export const DEFAULT_LOCAL_WEB_URL = "http://127.0.0.1:5173";

export const SETUP_FILE_NAME = "setup.json";

export type StartupTarget =
  | { kind: "app"; url: string; source: "env" | "saved" }
  | { kind: "setup" };

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Accepts what a person would actually type ("localhost:5173", "rakazo.example.com")
 * and returns a canonical http(s) origin plus optional base path, or null when the
 * input can never address a Rakazo server.
 */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    url = new URL(SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;
  // Embedded credentials would be written to disk in cleartext.
  if (url.username !== "" || url.password !== "") return null;

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Validates an untrusted value (saved file or IPC payload) into a usable setup. */
export function parseSetupInput(value: unknown): DesktopSetup | null {
  if (typeof value !== "object" || value === null) return null;

  const { mode, serverUrl } = value as Record<string, unknown>;
  if (mode !== "local" && mode !== "remote") return null;
  if (typeof serverUrl !== "string") return null;

  const normalized = normalizeServerUrl(serverUrl);
  return normalized === null ? null : { mode, serverUrl: normalized };
}

export function parseStoredSetup(raw: string): DesktopSetup | null {
  try {
    return parseSetupInput(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeSetup(setup: DesktopSetup): string {
  return `${JSON.stringify(setup, null, 2)}\n`;
}

/**
 * Decides between the first-run setup window and the app window. An explicit
 * `RAKAZO_WEB_URL` still wins over saved configuration so test and performance
 * harnesses can point the shell anywhere without touching a user's real setup.
 */
export function resolveStartupTarget(input: {
  envUrl?: string;
  saved?: DesktopSetup | null;
  forceSetup?: boolean;
}): StartupTarget {
  if (input.forceSetup === true) return { kind: "setup" };

  const envUrl = input.envUrl?.trim();
  if (envUrl !== undefined && envUrl !== "") return { kind: "app", url: envUrl, source: "env" };

  if (input.saved != null) {
    const normalized = normalizeServerUrl(input.saved.serverUrl);
    if (normalized !== null) return { kind: "app", url: normalized, source: "saved" };
  }
  return { kind: "setup" };
}

/** Turns a network failure into something a person can act on. */
export function probeFailureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return "Timed out reaching that address.";
  }

  const detail = error instanceof Error ? error.message : String(error);
  if (detail.includes("CONNECTION_REFUSED") || detail.includes("ECONNREFUSED")) {
    return "Nothing is listening at that address yet.";
  }
  if (detail.includes("NAME_NOT_RESOLVED") || detail.includes("ENOTFOUND")) {
    return "That host could not be found.";
  }
  if (detail.includes("CERT_") || detail.includes("SSL")) {
    return "The server's HTTPS certificate was rejected.";
  }
  return "Could not reach that address.";
}

/** The bundled renderer only stands in for a real http(s) origin. */
export function servesBundledRenderer(targetUrl: string): boolean {
  try {
    const { protocol } = new URL(targetUrl);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
