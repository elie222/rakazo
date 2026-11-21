import { getLogger } from "./logger.js";
import { markReportedError } from "./reported-errors.js";
import type { LogBindings } from "./types.js";

/**
 * Records a failure the caller is told to wait out, such as a dependency's outage, as a warning,
 * and marks this error as reported: a job wrapper or request handler that ends on it does not
 * report it again. A different error the same work fails with afterwards is still reported.
 */
export function warnExpectedFailure(message: string, error: unknown, bindings?: LogBindings): void {
  getLogger().warn(message, { ...bindings, error });
  markReportedError(error);
}
