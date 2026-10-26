import type { ComputerMode, ComputerStatus as ContractComputerStatus } from "@rakazo/contracts";
import { isLocalhostOrLoopbackIp, isPrivateNetworkHost } from "@rakazo/contracts";
import type { ScreenPageState } from "@rakazo/core";
import { isRetryableError, SCREEN_PAGE_STATES } from "@rakazo/core";
import { t } from "./i18n";

export const COMPUTER_HEARTBEAT_MS = 60_000;
/**
 * Computer lifecycle calls create, start or stop a container (booting, switching between the
 * Team and a Private computer); give them far more than an ordinary RPC.
 */
export const COMPUTER_LIFECYCLE_TIMEOUT_MS = 120_000;
export const SCREEN_URL_OPEN_ATTEMPTS = 5;
export const SCREEN_URL_RETRY_DELAY_MS = 400;
/**
 * Re-read an unsealed screen this long after the read. A sealed capability renews this long
 * after it was issued, which is before its own expiry even when a later client received it.
 */
export const SCREEN_URL_RENEW_MS = 50 * 60_000;

export type ComputerStatus = ContractComputerStatus;

export async function readScreenUrl(
  request: () => Promise<{ url: string | null }>,
  options: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string | null> {
  const attempts = Math.max(1, options.attempts ?? 1);
  const delayMs = options.delayMs ?? SCREEN_URL_RETRY_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const screen = await request();
      if (screen.url) return screen.url;
      lastError = undefined;
    } catch (error) {
      // A refused read (403, 404, 426...) will not change on the next attempt.
      if (!isRetryableError(error)) throw error;
      lastError = error;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  if (lastError) throw lastError;
  return null;
}

/** Point a loopback noVNC URL at the same host the app uses for the API. */
export function embeddableScreenUrl(url: string | null, apiBase: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const api = new URL(apiBase);
    if (isLocalhostOrLoopbackIp(parsed.hostname) && !isLocalhostOrLoopbackIp(api.hostname)) {
      parsed.hostname = api.hostname;
    }
    if (parsed.protocol === "http:" && !isPrivateNetworkHost(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Identity of a live screen stream, ignoring rotating capability tokens.
 * View vs control stays in the key so takeover/release still reconnects.
 */
export function screenStreamKey(url: string): string {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/novnc\/session\/(view|control)\/[^/]+(\/.*)?$/);
    if (match) return `${parsed.origin}/novnc/session/${match[1]}${match[2] ?? ""}`;
    const viewOnly = parsed.searchParams.get("view_only");
    const policy = viewOnly == null ? "" : `?view_only=${viewOnly}`;
    return `${parsed.origin}${parsed.pathname}${policy}`;
  } catch {
    return url;
  }
}

/**
 * Remaining life at which a same-stream capability is replaced.
 * Sealed URLs live one hour. The refresher re-reads `SCREEN_URL_RENEW_MS` after the seal
 * was issued, so a reused seal is refreshed before its original expiry. Slack covers clock
 * and timer skew so that fetch is applied before expiry.
 */
const SCREEN_CAPABILITY_TTL_MS = 60 * 60_000;
const SCREEN_SOURCE_RENEW_REMAINING_MS =
  SCREEN_CAPABILITY_TTL_MS - SCREEN_URL_RENEW_MS + 5 * 60_000;

function screenCapabilityExpiresAt(url: string): number | null {
  try {
    const match = new URL(url).pathname.match(/^\/novnc\/session\/(?:view|control)\/(\d+)\./);
    if (!match) return null;
    const expiresAt = Number(match[1]);
    return Number.isSafeInteger(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

/**
 * Time the screen-URL renew interval is measured from.
 * A sealed capability keeps the expiry it was issued with, so a later reader renews before
 * that expiry. URLs without one renew from the read itself.
 */
export function screenRenewReadAt(url: string | null, readAt: number): number {
  const expiresAt = url ? screenCapabilityExpiresAt(url) : null;
  if (expiresAt == null) return readAt;
  return expiresAt - SCREEN_CAPABILITY_TTL_MS;
}

/**
 * Keep the connected screen URL while only the capability token rotated.
 * Adopt a newer same-stream URL once the held capability is in the renew window,
 * so the proxy does not close the live stream when the original token expires.
 */
export function retainScreenSource(held: string, next: string, now = Date.now()): string {
  if (screenStreamKey(held) !== screenStreamKey(next)) return next;
  const heldExpires = screenCapabilityExpiresAt(held);
  const nextExpires = screenCapabilityExpiresAt(next);
  if (
    heldExpires != null &&
    nextExpires != null &&
    nextExpires > heldExpires &&
    heldExpires - now <= SCREEN_SOURCE_RENEW_REMAINING_MS
  ) {
    return next;
  }
  return held;
}

/**
 * URL the screen WebView should keep. A visible page ignores a same-stream capability
 * refresh, so the keyboard bridge stays attached to the document that is already loaded.
 * A hidden screen forgets the held URL and the next open loads the current capability.
 */
export function nextLoadedScreenUrl(
  held: string | null,
  next: string | null,
  visible: boolean,
  now = Date.now(),
): string | null {
  if (!visible || !next) return null;
  if (!held) return next;
  return retainScreenSource(held, next, now);
}

export function previewPlaceholder(
  state: string | undefined,
  booting: boolean,
  name: string,
  mode?: ComputerMode,
): string {
  if (state === "booting" || booting) return t("Booting live desktop…");
  if (state === "running") return computerLabel(mode, name);
  if (state === "suspended") return t("Computer is asleep. Take control to wake it.");
  if (state === "error") return t("Computer failed to boot");
  return t("Computer is stopped");
}

export function controlLabel(computer: ComputerStatus | null, name: string, botId?: string) {
  if (computer?.busyBotName) return t("{name} is using it", { name: computer.busyBotName });
  if (computer?.controlHolder === "user" && computer.controlBotId === botId) {
    return t("You have control");
  }
  if (computer?.state === "suspended") return t("Asleep");
  return computerLabel(computer?.mode, name);
}

export function computerLabel(mode: ComputerMode | undefined, name: string) {
  return mode === "dedicated" ? t("{name}’s computer", { name }) : t("Team Computer");
}

/**
 * The connection state a screen page posted to the WebView, or null. Only the exact
 * `{"rakazoScreen": <state>}` shape counts; anything else is the keyboard bridge's or no one's.
 */
export function screenPageState(data: string): ScreenPageState | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const keys = Object.keys(message);
  const state = (message as { rakazoScreen?: unknown }).rakazoScreen;
  if (keys.length !== 1 || keys[0] !== "rakazoScreen") return null;
  return (SCREEN_PAGE_STATES as readonly unknown[]).includes(state)
    ? (state as ScreenPageState)
    : null;
}

/**
 * A screen page's HTTP status through the web server's access check, or null if it couldn't
 * be asked. Only the status is read, and nothing about the request is logged. It is meant for
 * the server's status-only probe, which never redirects. React Native follows redirects
 * whatever `redirect` says, so an answer from anywhere but the URL asked counts as no page (0).
 */
export async function screenPageStatus(
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal,
    });
    void response.body?.cancel().catch(() => undefined);
    const elsewhere = Boolean(response.url) && response.url !== url;
    return elsewhere || response.redirected || response.type === "opaqueredirect"
      ? 0
      : response.status;
  } catch {
    return null;
  }
}

/**
 * Whether a screen URL goes through the web server's screen proxy, which answers probes. The
 * API hands it out sealed for the web server's address, which needn't be the API's own, so
 * only the session path tells.
 */
export function isProxiedScreenPage(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith("/novnc/session/");
  } catch {
    return false;
  }
}

/** Whether a WebView message came from the screen's own page, not a page it navigated to. */
export function fromScreenPage(pageUrl: string | undefined, screenUrl: string): boolean {
  try {
    return Boolean(pageUrl) && new URL(pageUrl!).origin === new URL(screenUrl).origin;
  } catch {
    return false;
  }
}
