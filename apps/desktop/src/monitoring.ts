import type { ClientOperation, MonitoringConfig } from "@rakazo/logging/monitoring";
import {
  createClientErrorReporter,
  isMonitoringUserId,
  nativeMonitoringDsn,
  sanitizeMonitoringEvent,
} from "@rakazo/logging/monitoring";
import type * as ElectronSentry from "@sentry/electron/main";
import { configureNativeCrashReporting, disableNativeCrashReporting } from "./native-crashes.js";

const errors = createClientErrorReporter();
let sdk: typeof ElectronSentry | undefined;
let generation = 0;
let identifications = 0;
let selected = false;
let userId: string | undefined;
let activeDsn: string | undefined;
let environment: string | undefined;
let activeTransport: ReturnType<typeof ElectronSentry.makeElectronTransport> | undefined;
let transportOptions: Parameters<typeof ElectronSentry.makeElectronTransport>[0] | undefined;
let configuring: Promise<void> = Promise.resolve();
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const owners = new Map<string, ReturnType<typeof ElectronSentry.makeElectronTransport>>();

export function reportDesktopError(
  error: unknown,
  operation: ClientOperation,
  tags?: Record<string, string>,
): void {
  errors.capture(error, operation, tags);
}

export function installDesktopEarlyErrorReporting(): void {
  process.on("uncaughtExceptionMonitor", (error) => {
    reportDesktopError(error, "desktop.startup");
  });
}

export function disableDesktopMonitoring(): void {
  generation++;
  identifications++;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  activeTransport = undefined;
  activeDsn = undefined;
  userId = undefined;
  owners.clear();
  sdk?.setUser(null);
  errors.install(undefined);
  if (sdk) disableNativeCrashReporting();
}

/** SDK observers initialize once; only the connection's transport and attribution change. */
export function configureDesktopMonitoring(
  fetchConfig: () => Promise<Response>,
  options: { version: string; base: string },
): Promise<void> {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  const current = ++generation;
  identifications++;
  if (selected) errors.reset();
  selected = true;
  if (sdk) disableNativeCrashReporting();
  activeTransport = undefined;
  activeDsn = undefined;
  owners.clear();
  userId = undefined;
  sdk?.setUser(null);
  let retryAttempt = 0;
  const retry = () => {
    if (current !== generation) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        configuring = configuring.then(attempt).catch(() => undefined);
      },
      Math.min(1_000 * 2 ** Math.min(retryAttempt++, 5), 30_000),
    );
    retryTimer.unref?.();
  };
  const attempt = async () => {
    if (current !== generation) return;
    const identification = identifications;
    let config: MonitoringConfig;
    try {
      const response = await fetchConfig();
      if (!response.ok) {
        retry();
        return;
      }
      config = (await response.json()) as MonitoringConfig;
    } catch {
      retry();
      return;
    }
    if (current !== generation) return;
    if (!config.dsn) {
      errors.install(undefined);
      return;
    }
    try {
      const Sentry = await import("@sentry/electron/main");
      if (current !== generation) return;
      const dsn = nativeMonitoringDsn(options.base, config.dsn, "desktop");
      if (!sdk) {
        Sentry.init({
          dsn,
          release: `rakazo-desktop@${options.version}`,
          ipcMode: Sentry.IPCMode.Classic,
          getSessions: () => [],
          defaultIntegrations: false,
          integrations: [
            Sentry.eventFiltersIntegration(),
            Sentry.linkedErrorsIntegration(),
            Sentry.dedupeIntegration(),
            Sentry.onUncaughtExceptionIntegration(),
          ],
          transport: (initialOptions) => {
            transportOptions = initialOptions;
            return {
              send: (envelope) => {
                const id =
                  typeof envelope[0].event_id === "string" ? envelope[0].event_id : undefined;
                const transport = id ? owners.get(id) : undefined;
                if (id) owners.delete(id);
                return transport?.send(envelope) ?? Promise.resolve({ statusCode: 200 });
              },
              flush: (timeout) => activeTransport?.flush(timeout) ?? Promise.resolve(true),
            };
          },
          enableOpenTelemetrySetup: false,
          dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: false,
            httpBodies: [],
            urlQueryParams: false,
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            stackFrameVariables: false,
          },
          beforeSend: (event, hint) => {
            if (!activeTransport) return null;
            const owner = event.tags?.["monitoring.connection"];
            if (owner !== generation) return null;
            hint.attachments = [];
            event.environment = environment;
            if (event.event_id) {
              if (owners.size >= 100) owners.delete(owners.keys().next().value!);
              owners.set(event.event_id, activeTransport);
            }
            const sanitized = sanitizeMonitoringEvent(
              event,
              event.tags?.["native.crash"] === "true" ? undefined : userId,
            );
            delete sanitized.contexts;
            return sanitized;
          },
        });
        sdk = Sentry;
      }
      const url = new URL(dsn);
      const project = url.pathname.split("/").pop()!;
      const prefix = url.pathname.slice(0, url.pathname.lastIndexOf("/"));
      const endpoint = `${url.origin}${prefix}/api/${project}/envelope/?sentry_key=${url.username}`;
      activeTransport = Sentry.makeElectronTransport({ ...transportOptions!, url: endpoint });
      activeDsn = config.dsn;
      environment = config.environment ?? undefined;
      userId =
        identification === identifications && isMonitoringUserId(config.userId)
          ? config.userId
          : undefined;
      configureNativeCrashReporting(options.base, (error, operation, tags) => {
        if (current === generation) reportDesktopError(error, operation, tags);
      });
      errors.install({
        capture: (error, operation, tags) => {
          if (current === generation)
            Sentry.captureException(error, {
              tags: { ...tags, operation, surface: "desktop", "monitoring.connection": current },
            });
        },
      });
    } catch {
      /* Keep the bounded queue until the connection can be configured again. */
    }
  };
  configuring = configuring.then(attempt).catch(() => undefined);
  return configuring;
}

export async function refreshDesktopMonitoringUser(
  fetchConfig: () => Promise<Response>,
): Promise<void> {
  userId = undefined;
  sdk?.setUser(null);
  const current = generation;
  const identification = ++identifications;
  try {
    const response = await fetchConfig();
    if (!response.ok) return;
    const config = (await response.json()) as MonitoringConfig;
    if (current === generation && identification === identifications && config.dsn === activeDsn)
      userId = isMonitoringUserId(config.userId) ? config.userId : undefined;
  } catch {
    /* Reports remain anonymous. */
  }
}
