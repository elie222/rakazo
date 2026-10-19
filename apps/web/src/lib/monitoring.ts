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
      beforeBreadcrumb: (breadcrumb) => {
        if (["console", "ui.click", "ui.input"].includes(breadcrumb.category ?? "")) return null;
        if (["fetch", "xhr", "navigation"].includes(breadcrumb.category ?? "")) {
          for (const key of ["url", "from", "to"]) {
            const value = breadcrumb.data?.[key];
            if (typeof value === "string") breadcrumb.data![key] = stripUrl(value);
          }
        }
        return breadcrumb;
      },
      beforeSend: (event) => {
        if (event.request) {
          if (event.request.url) event.request.url = stripUrl(event.request.url);
          delete event.request.headers;
          delete event.request.cookies;
          delete event.request.data;
        }
        delete event.user;
        if (event.message) event.message = scrubText(event.message);
        for (const value of event.exception?.values ?? []) {
          if (value.value) value.value = scrubText(value.value);
          for (const frame of value.stacktrace?.frames ?? []) {
            if (frame.filename) frame.filename = stripUrl(frame.filename);
            if (frame.abs_path) frame.abs_path = stripUrl(frame.abs_path);
          }
        }
        return event;
      },
    });
  } catch {
    console.warn("Browser error reporting failed to start");
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

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER = /\bBearer\s+[^\s"',;&]+/gi;

/** Error messages can quote user input; drop emails and bearer tokens before they leave. */
function scrubText(value: string): string {
  return value.replace(EMAIL, "[Redacted]").replace(BEARER, "Bearer [Redacted]");
}

function stripUrl(value: string): string {
  return value.split(/[?#]/, 1)[0]!;
}
