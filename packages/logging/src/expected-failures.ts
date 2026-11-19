import { enrichLogContext } from "./context.js";
import { getLogger } from "./logger.js";
import { markReportedError } from "./reported-errors.js";
import type { LogBindings } from "./types.js";

/**
 * Records a failure the caller is told to wait out, such as a dependency's outage, as a warning.
 * The request it fails answers without a server error report, and a job wrapper around it does
 * not report it again.
 */
export function warnExpectedFailure(message: string, error: unknown, bindings?: LogBindings): void {
  getLogger().warn(message, { ...bindings, error });
  enrichLogContext({ "error.expected": true });
  markReportedError(error);
}
