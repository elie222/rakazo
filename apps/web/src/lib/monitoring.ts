// Import just the classifier: monitoring loads before the app, ahead of the full core barrel.
import { isAbandonedRequest, isConnectionFailure } from "@rakazo/core/user-error";
import type { ClientOperation, MonitoringConfig } from "@rakazo/logging/monitoring";
import {
  createClientErrorReporter,
  isMonitoringUserId,
  sanitizeMonitoringEvent,
} from "@rakazo/logging/monitoring";
import type * as SentryReact from "@sentry/react";
import type { ErrorInfo } from "react";
import { importChunk, recoveringByReload } from "./preload-recovery";

// Load the SDK only when the connected API enables reporting.

const MAX_PENDING = 20;

let sentry: typeof SentryReact | undefined;
// Queue caught React errors until monitoring starts.
let pending: Array<[unknown, ErrorInfo]> | undefined = [];
// The signed-in user's pseudonymous id, minted by the API; the raw account id never leaves.
let userId: string | undefined;
let identifications = 0;
// Unknown until the session resolves; false means signed out.
let signedInState: boolean | undefined;
const errors = createClientErrorReporter();
let explicitlyDisabled = false;
let starting: Promise<boolean> | undefined;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function reportClientError(
  error: unknown,
  operation: ClientOperation,
  tags?: Record<string, string>,
): void {
  // A request that lost its connection, timed out or was cancelled is the network, not a bug.
  if (operation === "rpc.transport" && isConnectionFailure(error)) return;
  errors.capture(error, operation, tags);
}

/** Runs before the application imports, so module evaluation failures are captured too. */
export function installEarlyErrorReporting(target: Window = window): void {
  // An event without an error is a cross-origin script or a ResizeObserver loop: nothing to trace.
  const error = (event: ErrorEvent) => {
    if (!sentry && event.error != null) reportClientError(event.error, "react.render");
  };
  const rejection = (event: PromiseRejectionEvent) => {
    if (!sentry) reportClientError(event.reason, "react.render");
  };
  target.addEventListener("error", error);
  target.addEventListener("unhandledrejection", rejection);
  target.addEventListener("online", () => {
    if (!sentry && !explicitlyDisabled) void startMonitoring();
  });
}

export async function startMonitoring(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (starting) return starting;
  starting = (async () => {
    sentry = await loadSentry(fetchImpl);
    if (sentry || explicitlyDisabled) {
      const queued = pending ?? [];
      pending = undefined;
      for (const [error, errorInfo] of queued) sentry?.captureReactException(error, errorInfo);
      errors.install(
        sentry
          ? {
              capture: (error, operation, tags) =>
                sentry?.captureException(error, { tags: { ...tags, operation, surface: "web" } }),
            }
          : undefined,
      );
      clearTimeout(retryTimer);
    } else if (typeof window !== "undefined" && retries < 3) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        void startMonitoring(fetchImpl);
      }, [1000, 5000, 15000][retries++]!);
    }
    return sentry !== undefined;
  })();
  try {
    return await starting;
  } finally {
    starting = undefined;
  }
}

/** Follow sign-in and sign-out so reports count affected users without naming them. */
export async function identifyMonitoringUser(
  signedIn: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const current = ++identifications;
  signedInState = signedIn;
  userId = undefined;
  if (!signedIn || explicitlyDisabled) return;
  try {
    const response = await fetchImpl("/api/monitoring/config");
    if (!response.ok) return;
    const { userId: id } = (await response.json()) as MonitoringConfig;
    // A sign-out or another account that arrived meanwhile wins.
    if (current === identifications && isMonitoringUserId(id)) userId = id;
  } catch {
    // Reports go out without a user.
  }
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
  explicitlyDisabled = !config.dsn;
  if (!config.dsn) return undefined;
  // Errors queued during startup count the user too, unless a sign-out or a newer answer came first.
  if (signedInState !== false && userId === undefined && isMonitoringUserId(config.userId))
    userId = config.userId;
  let Sentry: typeof SentryReact;
  try {
    Sentry = await importChunk(() => import("@sentry/react"));
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
      // Completion reports carry no activity history or console content.
      maxBreadcrumbs: 0,
      integrations: (defaults) =>
        defaults.filter(
          (integration) => !["BrowserSession", "Breadcrumbs"].includes(integration.name),
        ),
      // An uncaught timeout or cancellation still means the network, not the code, and a stale
      // chunk the recovery reload is about to fix is not an error worth reporting.
      beforeSend: (event, hint) =>
        recoveringByReload() || isAbandonedRequest(hint?.originalException)
          ? null
          : sanitizeMonitoringEvent(event, userId),
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
  if (recoveringByReload()) return;
  if (sentry) sentry.captureReactException(error, errorInfo);
  else if (pending && pending.length < MAX_PENDING) pending.push([error, errorInfo]);
  console.error(error);
}
