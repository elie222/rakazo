import { getLogger } from "./logger.js";

/**
 * Awaits work whose failure the caller can ignore, such as cleanup. It never rejects: a failure
 * is logged once under the label, which says what was attempted, and resolves to undefined.
 */
export async function bestEffort<T>(
  label: string,
  attempt: PromiseLike<T> | undefined,
): Promise<T | undefined> {
  try {
    return await attempt;
  } catch (error) {
    // Cancellation is not a failure. It is not rethrown either: a caller that must stop on an
    // abort checks its own signal, as it did when the rejection was discarded in place.
    if (!isAbort(error)) getLogger().warn(`best effort failed: ${label}`, { error });
    return undefined;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
