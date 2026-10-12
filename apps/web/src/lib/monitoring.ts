import type * as SentryReact from "@sentry/react";
import type { ErrorInfo } from "react";

// Browser error reporting. The API says at runtime whether it is on, so one web build serves every
// deployment; the SDK is only downloaded when it is.

interface MonitoringConfig {
  dsn: string | null;
  environment?: string | null;
  release?: string | null;
  tunnel?: string;
}

const MAX_PENDING = 20;

let sentry: typeof SentryReact | undefined;
// Errors caught while startup is still in flight; sent once the SDK starts, dropped if it does not.
let pending: Array<[unknown, ErrorInfo]> | undefined = [];

export async function startMonitoring(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  sentry = await loadSentry(fetchImpl);
  const queued = pending ?? [];
  pending = undefined;
  for (const [error, errorInfo] of queued) sentry?.captureReactException(error, errorInfo);
  return sentry !== undefined;
}

async function loadSentry(fetchImpl: typeof fetch): Promise<typeof SentryReact | undefined> {
  let config: MonitoringConfig;
  try {
    const response = await fetchImpl("/api/monitoring/config");
    if (!response.ok) return undefined;
    config = (await response.json()) as MonitoringConfig;
  } catch {
    // The API is unreachable; the app shows its own connection error.
    return undefined;
  }
  if (!config.dsn) return undefined;
  let Sentry: typeof SentryReact;
  try {
    // A stale chunk after a deploy or a network failure must not surface as an unhandled rejection.
    Sentry = await import("@sentry/react");
    Sentry.init({
      dsn: config.dsn,
      environment: config.environment ?? undefined,
      release: config.release ?? undefined,
      tunnel: config.tunnel,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      // Sessions are not used by the collector, and console output can carry user content.
      integrations: (defaults) =>
        defaults.filter((integration) => integration.name !== "BrowserSession"),
      beforeBreadcrumb: (breadcrumb) => (breadcrumb.category === "console" ? null : breadcrumb),
    });
  } catch (error) {
    console.warn("Browser error reporting failed to start", error);
    return undefined;
  }
  return Sentry;
}

/**
 * React root `onCaughtError`: report errors an error boundary rendered a fallback for. Uncaught
 * render errors already reach `window.onerror`, where the SDK picks them up.
 */
export function reportCaughtReactError(error: unknown, errorInfo: ErrorInfo): void {
  if (sentry) sentry.captureReactException(error, errorInfo);
  else if (pending && pending.length < MAX_PENDING) pending.push([error, errorInfo]);
  console.error(error);
}
