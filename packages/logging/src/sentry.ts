import * as Sentry from "@sentry/node";
import { redactSensitiveText } from "./redaction.js";
import type { LogEvent, LogSink, SerializedError } from "./types.js";

// Error reporting to any Sentry-protocol collector (GlitchTip, Sentry, Bugsink). Only error-level
// logs are reported; everything else stays with the console and Axiom sinks.

export interface SentryConfig {
  dsn: string;
  environment?: string;
  release?: string;
}

const TAG_KEYS = ["request.id", "trace.id", "jobId", "runId"] as const;
const FLUSH_TIMEOUT_MS = 2_000;

export function sentryConfigFromEnv(source: NodeJS.ProcessEnv = process.env): {
  config?: SentryConfig;
  warning?: string;
} {
  const dsn = source.SENTRY_DSN?.trim();
  if (!dsn) return {};
  if (!isValidDsn(dsn)) {
    return { warning: "Error reporting is disabled; SENTRY_DSN is not a valid DSN." };
  }
  return {
    config: {
      dsn,
      environment: source.SENTRY_ENVIRONMENT?.trim() || undefined,
      release: source.SENTRY_RELEASE?.trim() || releaseFromGitSha(source.GIT_SHA),
    },
  };
}

export function isValidDsn(dsn: string): boolean {
  try {
    const url = new URL(dsn);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.username) &&
      /\/[\w-]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function createSentrySink(
  service: string,
  config: SentryConfig,
  transport?: Sentry.NodeOptions["transport"],
): LogSink {
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    transport,
    // A message-only error log would otherwise carry a stack captured inside this sink, and the
    // collector would group every such log as one issue titled after that frame.
    attachStacktrace: false,
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
    // No automatic HTTP, console, or library instrumentation: errors arrive through the logger,
    // plus uncaught exceptions. Unhandled rejections are left alone, because any listener on that
    // event stops Node from crashing.
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
    ],
    beforeSend: redactEvent,
  });
  Sentry.setTag("service", service);
  return {
    write(event: LogEvent) {
      if (event.level !== "error") return;
      const { "service.name": service, error } = event;
      const message = redactSensitiveText(event.message);
      Sentry.withScope((scope) => {
        scope.setTag("service", service);
        for (const key of TAG_KEYS) {
          const value = event[key];
          if (typeof value === "string" && value.length > 0 && value.length <= 200)
            scope.setTag(key, redactSensitiveText(value));
        }
        scope.setExtra("log.message", message);
        if (error) {
          Sentry.captureException(rebuildError(error));
        } else {
          Sentry.captureMessage(message, "error");
        }
      });
    },
    async flush() {
      await Sentry.flush(FLUSH_TIMEOUT_MS);
    },
  };
}

export function createSentrySinkFromEnv(
  service: string,
  source: NodeJS.ProcessEnv = process.env,
): {
  sink?: LogSink;
  warning?: string;
} {
  const { config, warning } = sentryConfigFromEnv(source);
  return config ? { sink: createSentrySink(service, config) } : { warning };
}

function releaseFromGitSha(sha: string | undefined): string | undefined {
  const value = sha?.trim();
  return value && value !== "unknown" ? value : undefined;
}

/** The logger hands sinks a serialized error; rebuild one Sentry can parse, cause chain included. */
function rebuildError(serialized: SerializedError): Error {
  const message = redactSensitiveText(serialized.message);
  const error = new Error(message);
  error.name = redactSensitiveText(serialized.name);
  error.stack = serialized.stack
    ? redactSensitiveText(serialized.stack)
    : `${error.name}: ${message}`;
  if (serialized.cause) error.cause = rebuildError(serialized.cause);
  return error;
}

function redactEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  event.server_name = undefined;
  if (event.extra) {
    const message = event.extra["log.message"];
    event.extra =
      typeof message === "string" ? { "log.message": redactSensitiveText(message) } : {};
  }
  if (event.message) event.message = redactSensitiveText(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = redactSensitiveText(value.value);
    for (const frame of value.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = redactSensitiveText(frame.filename);
      if (frame.abs_path) frame.abs_path = redactSensitiveText(frame.abs_path);
      if (frame.module) frame.module = redactSensitiveText(frame.module);
      delete frame.vars;
    }
  }
  return event;
}
