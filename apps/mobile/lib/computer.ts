import type { ComputerMode, ComputerStatus as ContractComputerStatus } from "@rakazo/contracts";
import { t } from "./i18n";

export const COMPUTER_HEARTBEAT_MS = 60_000;
/**
 * Computer lifecycle calls create, start or stop a container (booting, switching between the
 * Team and a Private computer); give them far more than an ordinary RPC.
 */
export const COMPUTER_LIFECYCLE_TIMEOUT_MS = 120_000;
export const SCREEN_URL_OPEN_ATTEMPTS = 5;
export const SCREEN_URL_RETRY_DELAY_MS = 400;
/** Re-read `computer/screenUrl` this long after the last successful seal. */
export const SCREEN_URL_RENEW_MS = 50 * 60_000;

export type ComputerStatus = ContractComputerStatus;

function isLocalHostname(hostname: string) {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

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
    if (isLocalHostname(parsed.hostname) && !isLocalHostname(api.hostname)) {
      parsed.hostname = api.hostname;
    }
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
 * Sealed URLs live one hour; the refresher re-reads at `SCREEN_URL_RENEW_MS`.
 * Slack covers clock and timer skew so that fetch is applied before expiry.
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
