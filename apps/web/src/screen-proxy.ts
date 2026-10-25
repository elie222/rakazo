import type { IncomingHttpHeaders } from "node:http";
import type { ScreenProxyTarget } from "@rakazo/core/node/screen-capability";
import {
  isScreenProxyTarget,
  SCREEN_RECHECK_MS,
  SCREEN_TARGET_ENDPOINT,
} from "@rakazo/core/node/screen-capability";

const SENSITIVE_FORWARD_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
]);

/** Fail closed when the authoritative lifecycle check is unavailable. */
export async function resolveNovncTarget(
  url: string | undefined,
  secret: string,
  api: string,
  onFailure?: (reason: ScreenTargetFailure) => void,
): Promise<ScreenProxyTarget | null> {
  if (!url?.startsWith("/novnc/session/")) {
    onFailure?.("invalid_path");
    return null;
  }
  try {
    const response = await fetch(new URL(SCREEN_TARGET_ENDPOINT, api), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ path: url }),
    });
    if (!response.ok) {
      onFailure?.("authority_rejected");
      return null;
    }
    let target: unknown;
    try {
      target = await response.json();
    } catch (error) {
      onFailure?.(
        error instanceof SyntaxError ? "invalid_authority_response" : "authority_unavailable",
      );
      return null;
    }
    if (isScreenProxyTarget(target)) return target;
    onFailure?.("invalid_authority_response");
    return null;
  } catch {
    onFailure?.("authority_unavailable");
    return null;
  }
}

export type ScreenTargetFailure =
  | "invalid_path"
  | "authority_rejected"
  | "invalid_authority_response"
  | "authority_unavailable";

function isHttp2PseudoHeader(key: string) {
  return key.startsWith(":");
}

export function safeProxyHeaders(
  headers: IncomingHttpHeaders,
  upstreamHeaders?: Record<string, string>,
) {
  return {
    ...Object.fromEntries(
      Object.entries(headers).filter(([key, value]) => {
        return (
          value != null &&
          !isHttp2PseudoHeader(key) &&
          !SENSITIVE_FORWARD_HEADERS.has(key.toLowerCase())
        );
      }),
    ),
    ...upstreamHeaders,
  };
}

/** Recheck streams as well as new requests; no positive authorization cache. */
export function watchScreenAuthorization(check: () => Promise<boolean>, revoke: () => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    let allowed = false;
    try {
      allowed = Boolean(await check());
    } catch {
      /* Fail closed. */
    }
    if (stopped) return;
    if (!allowed) {
      stopped = true;
      revoke();
      return;
    }
    timer = setTimeout(tick, SCREEN_RECHECK_MS);
    timer.unref?.();
  };
  timer = setTimeout(tick, SCREEN_RECHECK_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
