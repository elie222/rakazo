import { redactSensitiveText } from "./redaction.js";

const WINDOW_MS = 30_000;
let failures = 0;
let lastFailureAt: number | null = null;
let droppedLines = 0;

/** `degraded` tracks sink failures only; a line dropped before any sink saw it is counted apart. */
export function logSinkHealth(now = Date.now()) {
  return {
    failures,
    lastFailureAt,
    degraded: lastFailureAt !== null && now - lastFailureAt < 300_000,
    droppedLines,
  };
}

function throttledReporter(label: string): (error: unknown) => void {
  let lastReportAt = 0;
  let suppressed = 0;
  return (error) => {
    const now = Date.now();
    if (now - lastReportAt < WINDOW_MS) {
      suppressed += 1;
      return;
    }
    const extra = suppressed > 0 ? ` (${suppressed} suppressed)` : "";
    suppressed = 0;
    lastReportAt = now;
    const message = describeError(error);
    console.error(`${label}${extra}`, redactSensitiveText(message));
  };
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? (error.stack ?? error.message) : String(error);
  } catch {
    return "unprintable error";
  }
}

const reportSinkFailure = throttledReporter("log sink failed");
const reportLineDropped = throttledReporter("log line dropped");

export function reportSinkError(error: unknown): void {
  failures += 1;
  lastFailureAt = Date.now();
  reportSinkFailure(error);
}

/** A line that failed while it was built, before any sink saw it. */
export function reportDroppedLine(error: unknown): void {
  droppedLines += 1;
  reportLineDropped(error);
}

export function guardedWrite(write: () => void | Promise<void>): void {
  try {
    const result = write();
    if (result && typeof result.then === "function") {
      void result.catch(reportSinkError);
    }
  } catch (error) {
    reportSinkError(error);
  }
}

export async function guardedFlush(flush?: () => void | Promise<void>): Promise<void> {
  if (!flush) return;
  try {
    await flush();
  } catch (error) {
    reportSinkError(error);
  }
}
