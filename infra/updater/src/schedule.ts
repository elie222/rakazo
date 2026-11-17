import { abortableDelay } from "@rakazo/core";
import type { createUpdaterApp } from "./index.js";
import { truncateOutput } from "./updater-logic.js";

/** A restart waits a full interval, and long-running updates never overlap scheduled checks. */
export function startUpdateSchedule(
  intervalMs: number,
  update: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  if (intervalMs === 0) return async () => {};
  const stop = new AbortController();
  const pending = (async () => {
    while (!stop.signal.aborted) {
      await abortableDelay(intervalMs, stop.signal);
      if (stop.signal.aborted) break;
      try {
        await update();
      } catch (error) {
        onError(error);
      }
    }
  })();
  return async () => {
    stop.abort();
    await pending;
  };
}

/** Scheduled checks have no branch or channel input: only official stable releases. */
export async function applyStableUpdate(app: ReturnType<typeof createUpdaterApp>) {
  const result = await app.applyScheduledUpdate();
  if (!result.ok) {
    const diagnostics = result.steps
      ?.filter((step) => !step.ok)
      .map((step) => `${step.label}: ${step.output}`)
      .join("\n");
    throw new Error(
      [
        result.error || "Scheduled update failed.",
        result.restart ? `Recovery status: ${result.restart}.` : "",
        result.restartAdvice,
        diagnostics ? truncateOutput(diagnostics) : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}
