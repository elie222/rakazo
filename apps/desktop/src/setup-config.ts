import { createHash } from "node:crypto";
import { isIP } from "node:net";
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
 * and returns a canonical http(s) origin, or null when the input can never
 * securely address a Rakazo server.
 */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    if (SCHEME.test(trimmed)) {
      url = new URL(trimmed);
    } else {
      const candidate = new URL(`http://${trimmed}`);
      url = isLocalNetworkHost(candidate.hostname) ? candidate : new URL(`https://${trimmed}`);
    }
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;
  // Embedded credentials would be written to disk in cleartext.
  if (url.username !== "" || url.password !== "") return null;
  // Public login cookies and API traffic must never cross a cleartext connection.
  if (url.protocol === "http:" && !isLocalNetworkHost(url.hostname)) return null;

  // Rakazo serves its renderer, RPC, and auth routes from one origin. Keeping a
  // user-supplied path would make the setup probe and the loaded app disagree.
  return url.origin;
}

/** Validates an untrusted value (saved file or IPC payload) into a usable setup. */
export function parseSetupInput(value: unknown): DesktopSetup | null {
  if (typeof value !== "object" || value === null) return null;

  const { mode, serverUrl } = value as Record<string, unknown>;
  if (mode !== "new" && mode !== "existing") return null;
  if (typeof serverUrl !== "string") return null;

  const normalized = normalizeServerUrl(serverUrl);
  if (normalized === null) return null;
  if (mode === "new" && !isLoopbackHost(new URL(normalized).hostname)) return null;
  return { mode, serverUrl: normalized };
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
    const saved = parseSetupInput(input.saved);
    if (saved !== null) return { kind: "app", url: saved.serverUrl, source: "saved" };
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

/** Each Rakazo origin gets its own persistent cookie and storage partition. */
export function sessionPartitionForServerUrl(targetUrl: string): string | null {
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const digest = createHash("sha256").update(url.origin).digest("hex").slice(0, 24);
    return `persist:rakazo-${digest}`;
  } catch {
    return null;
  }
}

/** External pages are opened by the OS, never in a privileged Electron child window. */
export function safeExternalUrl(targetUrl: string): string | null {
  if (!servesBundledRenderer(targetUrl)) return null;
  return new URL(targetUrl).toString();
}

export function isRakazoHealth(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const json = (value as { json?: unknown }).json;
  return (
    typeof json === "object" &&
    json !== null &&
    (json as { ok?: unknown }).ok === true &&
    typeof (json as { version?: unknown }).version === "string"
  );
}

function isLoopbackHost(hostname: string) {
  const host = unbracketedHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return isIP(host) === 6 && host === "::1";
}

/**
 * Link-local addresses (IPv4 169.254/16, IPv6 fe80::/10) often host cloud
 * metadata endpoints. Cleartext HTTP to them is never a legitimate Rakazo
 * deploy target, so they stay out of the private-network HTTP allowlist.
 */
function isLinkLocalHost(hostname: string) {
  const host = unbracketedHost(hostname);
  if (isIP(host) === 4) {
    const [first, second] = host.split(".").map(Number);
    return first === 169 && second === 254;
  }
  if (isIP(host) === 6) {
    const first = host.split(":", 1)[0] ?? "";
    return /^fe[89ab]/.test(first);
  }
  return false;
}

function isLocalNetworkHost(hostname: string) {
  const host = unbracketedHost(hostname);
  if (isLoopbackHost(host) || host.endsWith(".local")) return true;
  if (isLinkLocalHost(host)) return false;

  if (isIP(host) === 4) {
    const [first, second] = host.split(".").map(Number);
    return (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  if (isIP(host) === 6) {
    const first = host.split(":", 1)[0] ?? "";
    // Unique-local only (fc00::/7). Link-local is rejected above.
    return /^f[cd]/.test(first);
  }
  return false;
}

function unbracketedHost(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}
