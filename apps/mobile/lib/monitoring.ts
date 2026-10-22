import type { ClientOperation, MonitoringConfig } from "@rakazo/logging/monitoring";
import {
  createClientErrorReporter,
  isMonitoringUserId,
  nativeMonitoringDsn,
  sanitizeMonitoringEvent,
} from "@rakazo/logging/monitoring";
import type * as NativeSentry from "@sentry/react-native";

const errors = createClientErrorReporter();
let sdk: typeof NativeSentry | undefined;
let generation = 0;
let connectionKey: string | undefined;
let configured = false;
let closing: Promise<unknown> = Promise.resolve();
let configuring: Promise<void> | undefined;

export function reportMobileError(
  error: unknown,
  operation: ClientOperation,
  tags?: Record<string, string>,
): void {
  errors.capture(error, operation, tags);
}

/** Clear account context synchronously, before a server/session change starts any I/O. */
export function resetMobileMonitoring(): void {
  generation += 1;
  connectionKey = undefined;
  configured = false;
  errors.reset();
  sdk?.setUser(null);
  if (sdk) closing = sdk.close().catch(() => undefined);
  sdk = undefined;
}

/** Runtime configuration belongs to the selected server; no vendor-specific mobile env vars. */
export function configureMobileMonitoring(
  base: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = JSON.stringify([base, headers]);
  if (key === connectionKey && (configured || configuring)) return configuring ?? Promise.resolve();
  if (connectionKey !== undefined && key !== connectionKey) errors.reset();
  connectionKey = key;
  configured = false;
  const current = ++generation;
  sdk?.setUser(null);
  const next = (configuring ?? Promise.resolve()).then(async () => {
    if (current !== generation) return;
    await closing;
    if (sdk) await sdk.close();
    sdk = undefined;
    let config: MonitoringConfig;
    try {
      const response = await fetchImpl(`${base}/api/monitoring/config`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return;
      config = (await response.json()) as MonitoringConfig;
    } catch {
      return;
    }
    if (current !== generation) return;
    if (!config.dsn) {
      configured = true;
      errors.install(undefined);
      return;
    }
    try {
      const Sentry = await import("@sentry/react-native");
      if (current !== generation) return;
      const userId = isMonitoringUserId(config.userId) ? config.userId : undefined;
      Sentry.init({
        dsn: nativeMonitoringDsn(base, config.dsn, "mobile"),
        environment: config.environment ?? undefined,
        // Keep the native binary release for symbolication, distinct from the server release.
        sendDefaultPii: false,
        enableLogs: false,
        enableAutoSessionTracking: false,
        enableAutoPerformanceTracing: false,
        maxBreadcrumbs: 0,
        attachScreenshot: false,
        attachViewHierarchy: false,
        enableNativeNagger: false,
        integrations: (defaults) =>
          defaults.filter((integration) =>
            [
              "ReactNativeErrorHandlers",
              "LinkedErrors",
              "Dedupe",
              "NativeLinkedErrors",
              "EventFilters",
              "NativeRelease",
              "ReactNativeInfo",
              "RewriteFrames",
              "DebugMeta",
              "SdkInfo",
              "EventOrigin",
            ].includes(integration.name),
          ),
        beforeBreadcrumb: () => null,
        beforeSend: (event) =>
          current === generation ? sanitizeMonitoringEvent(event, userId) : null,
      });
      sdk = Sentry;
      configured = true;
      Sentry.setTag("surface", "mobile");
      Sentry.setUser(userId ? { id: userId, ip_address: null } : null);
      errors.install({
        capture: (error, operation, tags) => {
          if (current === generation)
            Sentry.captureException(error, { tags: { ...tags, operation, surface: "mobile" } });
        },
      });
    } catch {
      // Retain the bounded startup queue; foreground/reconnect retries configuration.
    }
  });
  const pending = next.catch(() => undefined);
  configuring = pending;
  void pending.finally(() => {
    if (configuring === pending) configuring = undefined;
  });
  return pending;
}

/** Install before Expo Router imports so early JS failures retain their original handler. */
export function installMobileEarlyErrorReporting(): void {
  const target = globalThis as typeof globalThis & {
    ErrorUtils?: {
      getGlobalHandler(): (error: Error, fatal?: boolean) => void;
      setGlobalHandler(handler: (error: Error, fatal?: boolean) => void): void;
    };
  };
  const previous = target.ErrorUtils?.getGlobalHandler();
  if (previous)
    target.ErrorUtils?.setGlobalHandler((error, fatal) => {
      if (!sdk) reportMobileError(error, "react.render");
      previous(error, fatal);
    });
}
