import { errorText } from "./user-error";

export interface ComputerScreenResult {
  url: string | null;
  error: string | null;
}

/** Only the latest request for the visible computer may replace its screen or error. */
export async function loadComputerScreen(options: {
  load: () => Promise<{ url: string | null }>;
  isCurrent: () => boolean;
  commit: (result: ComputerScreenResult) => void;
  fallbackError: string;
}): Promise<string | null> {
  let result: ComputerScreenResult;
  try {
    const screen = await options.load();
    result = { url: screen.url, error: null };
  } catch (error) {
    result = {
      url: null,
      error: errorText(error, options.fallbackError),
    };
  }
  if (!options.isCurrent()) return null;
  options.commit(result);
  return result.url;
}

export function embeddableScreenUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    const page = new URL(window.location.href);
    // The server that served this page proxies /novnc/. Keep the frame on this origin even when the
    // API's WEB_ORIGIN names another host for it (localhost vs 127.0.0.1), as the CSP frames 'self'.
    if (parsed.pathname.startsWith("/novnc/")) {
      return `${page.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
    if (local && parsed.port && parsed.port !== pagePort) {
      return null;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function screenIframeSandbox(url: string | null) {
  if (!url) return undefined;
  try {
    return new URL(url, window.location.href).pathname.startsWith("/novnc/")
      ? "allow-scripts allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}

/** Deduplicate only the boot request; callers can still take over and refresh. */
export async function bootComputerOnce<T>(
  inFlight: Map<string, symbol>,
  botId: string,
  boot: () => Promise<T>,
): Promise<T | undefined> {
  if (inFlight.has(botId)) return;
  const token = Symbol(botId);
  inFlight.set(botId, token);
  try {
    return await boot();
  } finally {
    if (inFlight.get(botId) === token) inFlight.delete(botId);
  }
}

/** Only pages the web proxy serves carry the shim that reports their state to the app. */
export function isProxiedScreenUrl(url: string | null): url is string {
  return screenIframeSandbox(url) !== undefined;
}

/** How long a framed screen may stay silent before the app treats it as not loaded. */
export const SCREEN_FRAME_LOAD_TIMEOUT_MS = 15_000;

export type ScreenFrameState = "loading" | "connecting" | "connected" | "failed" | "disconnected";

export interface ScreenFrameMessage {
  rakazoScreen: ScreenFrameState;
  detail?: string;
}

const SCREEN_FRAME_STATES: ReadonlySet<string> = new Set<ScreenFrameState>([
  "loading",
  "connecting",
  "connected",
  "failed",
  "disconnected",
]);

/** A state report posted by a framed screen page, or null for any other message. */
export function screenFrameMessage(data: unknown): ScreenFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const { rakazoScreen, detail } = data as Record<string, unknown>;
  if (typeof rakazoScreen !== "string" || !SCREEN_FRAME_STATES.has(rakazoScreen)) return null;
  const text = typeof detail === "string" ? detail.trim().slice(0, 200) : "";
  return { rakazoScreen: rakazoScreen as ScreenFrameState, ...(text ? { detail: text } : {}) };
}

/** Whether a report shows the page got past loading; a page stalled there is still silent. */
export function screenFrameStarted(message: ScreenFrameMessage): boolean {
  return message.rakazoScreen !== "loading";
}

/** The error a frame report means for the screen, or null while it is fine. */
export function screenFrameError(message: ScreenFrameMessage, fallback: string): string | null {
  if (message.rakazoScreen !== "failed" && message.rakazoScreen !== "disconnected") return null;
  return message.detail ?? fallback;
}

/**
 * Ask the proxy for the page before framing it. A frame cannot say why it failed to load, so a
 * refused or unreachable screen would otherwise stay blank.
 */
export async function probeScreen(
  url: string,
  fallback: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
    });
    if (response.ok) return null;
    if (response.type === "opaqueredirect") return fallback;
    const contentType = response.headers?.get("content-type") ?? "";
    const body = (await response.text().catch(() => "")).trim();
    // Only the proxy's own short plain-text reasons are worth showing; an upstream HTML error
    // page would read as raw markup in the alert.
    const isHtml = /html/i.test(contentType) || /<[a-z!/]/i.test(body);
    const text = isHtml ? "" : body.slice(0, 200);
    return text || `${fallback} (HTTP ${response.status})`;
  } catch {
    return fallback;
  }
}
