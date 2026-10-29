// Import just the classifier: monitoring loads before the app, ahead of the full core barrel.
import { isAbandonedRequest, isConnectionFailure } from "@rakazo/core/user-error";
import type { ClientOperation, MonitoringConfig } from "@rakazo/logging/monitoring";
import {
  createClientErrorReporter,
  isMonitoringUserId,
  nativeMonitoringDsn,
  sanitizeMonitoringEvent,
} from "@rakazo/logging/monitoring";
import type * as NativeSentry from "@sentry/react-native";
import type { NativeApplication, StartupErrorStorage } from "./startup-error";
import {
  clearStartupError,
  markExpoErrorReported,
  readStartupError,
  saveStartupError,
  startExpoErrorWindow,
} from "./startup-error";

const errors = createClientErrorReporter();
let sdk: typeof NativeSentry | undefined;
let generation = 0;
let connectionKey: string | undefined;
let configured = false;
let closing: Promise<unknown> = Promise.resolve();
let configuring: Promise<void> | undefined;
let configRequest: AbortController | undefined;
let replayRequest: AbortController | undefined;
let reportingReady: (() => void) | undefined;
let earlyHandlerInstalled = false;
let handlingEarlyFatal = false;
let pendingStartupError: Error | undefined;
let startupStorage: StartupErrorStorage | undefined;
let nativeApplication: NativeApplication | undefined;
let previousLaunch: { release?: string; dist?: string } | undefined;
let screen = "other";

/** Bound the time given to configuration and the native SDK before preserving RN's fatal path. */
async function flushStartupError(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (!sdk)
          await new Promise<void>((resolve) => {
            reportingReady = resolve;
          });
        const reporter = sdk;
        const current = generation;
        if (reporter && (await reporter.flush()) && reporter === sdk && current === generation) {
          pendingStartupError = undefined;
          clearStartupError(startupStorage);
        }
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]);
  } catch {
    // The next launch can retry the persisted report.
  } finally {
    clearTimeout(timer);
    reportingReady = undefined;
  }
}

export function reportMobileError(
  error: unknown,
  operation: ClientOperation,
  tags?: Record<string, string>,
): void {
  // A request that lost its connection, timed out or was cancelled is the network, not a bug.
  if (operation === "rpc.transport" && isConnectionFailure(error)) return;
  errors.capture(error, operation, tags);
}

/** A coarse screen name, so an out-of-memory report says what was open; never route params. */
export function setMobileMonitoringScreen(next: string | undefined): void {
  screen = next ?? "other";
  sdk?.setTag("screen", screen);
}

/** Clear account context synchronously, before a server/session change starts any I/O. */
export function resetMobileMonitoring(): void {
  generation += 1;
  configRequest?.abort();
  replayRequest?.abort();
  pendingStartupError = undefined;
  clearStartupError(startupStorage);
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
  startExpoErrorWindow(startupStorage, base);
  const key = JSON.stringify([base, headers]);
  if (key === connectionKey && (configured || configuring)) return configuring ?? Promise.resolve();
  // The first anonymous request can be upgraded to this server's saved session. Session
  // changes still call resetMobileMonitoring; do not discard the fatal startup error here.
  if (
    connectionKey !== undefined &&
    key !== connectionKey &&
    connectionKey !== JSON.stringify([base, {}])
  ) {
    errors.reset();
    pendingStartupError = undefined;
    clearStartupError(startupStorage);
  }
  configRequest?.abort();
  replayRequest?.abort();
  connectionKey = key;
  configured = false;
  const current = ++generation;
  sdk?.setUser(null);
  const next = (configuring ?? Promise.resolve()).then(async () => {
    if (current !== generation) return;
    await closing;
    if (current !== generation) return;
    if (sdk) await sdk.close();
    sdk = undefined;
    if (current !== generation) return;
    let config: MonitoringConfig;
    const request = new AbortController();
    configRequest = request;
    const timeout = setTimeout(() => request.abort(), 8_000);
    try {
      const response = await fetchImpl(`${base}/api/monitoring/config`, {
        headers,
        signal: request.signal,
      });
      if (!response.ok) return;
      config = (await response.json()) as MonitoringConfig;
    } catch {
      return;
    } finally {
      clearTimeout(timeout);
      if (configRequest === request) configRequest = undefined;
    }
    if (current !== generation) return;
    if (!config.dsn) {
      configured = true;
      errors.install(undefined);
      pendingStartupError = undefined;
      clearStartupError(startupStorage);
      reportingReady?.();
      return;
    }
    try {
      const Sentry = await import("@sentry/react-native");
      const { Platform } = await import("./monitoring-platform");
      const updates = await import("expo-updates");
      const { channel } = updates;
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
              "Release",
              "ReactNativeInfo",
              "RewriteFrames",
              "DebugMeta",
              "SdkInfo",
              "EventOrigin",
            ].includes(integration.name),
          ),
        beforeBreadcrumb: () => null,
        beforeSend: (event, hint) => {
          if (
            current !== generation ||
            (event.level !== "fatal" && isAbandonedRequest(hint?.originalException))
          )
            return null;
          if (Platform.OS === "ios" || Platform.OS === "android")
            event.tags = { ...event.tags, "mobile.platform": Platform.OS };
          return sanitizeMonitoringEvent(
            event,
            event.tags?.["startup.previous_launch"] === "true" ? undefined : userId,
          );
        },
      });
      sdk = Sentry;
      configured = true;
      Sentry.setTag("surface", "mobile");
      Sentry.setTag("screen", screen);
      if (Platform.OS === "ios" || Platform.OS === "android")
        Sentry.setTag("mobile.platform", Platform.OS);
      Sentry.setUser(userId ? { id: userId, ip_address: null } : null);
      errors.install({
        capture: (error, operation, tags) => {
          if (current === generation)
            Sentry.captureException(error, { tags: { ...tags, operation, surface: "mobile" } });
        },
      });
      if (pendingStartupError) {
        Sentry.captureException(pendingStartupError, {
          mechanism: { handled: false, type: "onerror" },
          captureContext: {
            level: "fatal",
            tags: {
              operation: "mobile.startup",
              surface: "mobile",
              ...(previousLaunch ? { "startup.previous_launch": "true" } : {}),
            },
            // The SDK's Release integration reads these before beforeSend drops extras.
            ...(previousLaunch?.release
              ? {
                  extra: {
                    __sentry_release: previousLaunch.release,
                    __sentry_dist: previousLaunch.dist,
                  },
                }
              : {}),
          },
        });
      }
      if (reportingReady) reportingReady();
      else if (pendingStartupError) void flushStartupError();
      const expoErrorWindow = startExpoErrorWindow(startupStorage, base);
      if (channel === "diagnostic" && expoErrorWindow) {
        const replay = new AbortController();
        replayRequest = replay;
        let interrupt!: () => void;
        const interrupted = new Promise<void>((resolve) => {
          interrupt = resolve;
        });
        replay.signal.addEventListener("abort", interrupt, { once: true });
        const timeout = setTimeout(() => replay.abort(), 2_000);
        // Expo records the original recovery error even when no JS handler can report it.
        const recovery = updates
          .readLogEntriesAsync(3_600_000)
          .then((entries) => {
            if (current !== generation || replay.signal.aborted) return;
            const latest = entries
              .filter(
                (entry) =>
                  entry.code === "JSRuntimeError" &&
                  (entry.level === "error" || entry.level === "fatal") &&
                  entry.timestamp >= expoErrorWindow.since &&
                  entry.timestamp > expoErrorWindow.reportedThrough,
              )
              .sort((a, b) => a.timestamp - b.timestamp)
              .at(-1);
            if (!latest) return;
            const error = new Error(latest.message.slice(0, 8_192));
            error.name = "ExpoStartupError";
            Sentry.captureException(error, {
              mechanism: { handled: false, type: "expo.error_recovery" },
              captureContext: {
                level: "fatal",
                tags: {
                  operation: "mobile.startup",
                  surface: "mobile",
                  "startup.previous_launch": "true",
                },
              },
            });
            return Sentry.flush().then((sent) => {
              if (sent && !replay.signal.aborted)
                markExpoErrorReported(latest.timestamp, startupStorage, base);
            });
          })
          .catch(() => undefined);
        try {
          await Promise.race([recovery, interrupted]);
        } finally {
          clearTimeout(timeout);
          replay.signal.removeEventListener("abort", interrupt);
          if (replayRequest === replay) replayRequest = undefined;
        }
      }
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
export function installMobileEarlyErrorReporting(
  storage: StartupErrorStorage,
  application: NativeApplication,
): void {
  if (earlyHandlerInstalled) return;
  earlyHandlerInstalled = true;
  startupStorage = storage;
  nativeApplication = application;
  startExpoErrorWindow(storage);
  const saved = readStartupError(storage);
  pendingStartupError = saved?.error;
  previousLaunch = saved;
  const target = globalThis as typeof globalThis & {
    ErrorUtils?: {
      getGlobalHandler(): (error: Error, fatal?: boolean) => void;
      setGlobalHandler(handler: (error: Error, fatal?: boolean) => void): void;
    };
  };
  const previous = target.ErrorUtils?.getGlobalHandler();
  if (previous)
    target.ErrorUtils?.setGlobalHandler((error, fatal) => {
      if (!sdk) {
        if (fatal) {
          if (handlingEarlyFatal) return;
          handlingEarlyFatal = true;
          if (!pendingStartupError) {
            pendingStartupError = error;
            previousLaunch = undefined;
            saveStartupError(error, startupStorage, nativeApplication);
          }
          void flushStartupError().finally(() => previous(error, fatal));
          return;
        }
        reportMobileError(error, "react.render");
      }
      previous(error, fatal);
    });
}
