import { requestDeadline, withAbort } from "@rakazo/core";

const STOP_DRAIN_MS = 5_000;
const chains = new Map<string, Promise<void>>();
const captureFinishers = new Map<string, () => void>();
const stopping = new Set<string>();

// One chain per bot so a protected paste follows the click that focused the field.
export function enqueueTeachComputerInput(botId: string, task: () => Promise<void>): Promise<void> {
  const previous = chains.get(botId) ?? Promise.resolve();
  const result = previous.then(task);
  chains.set(
    botId,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

export function registerTeachCaptureFinisher(skillId: string, finish: () => void): () => void {
  captureFinishers.set(skillId, finish);
  return () => {
    if (captureFinishers.get(skillId) === finish) captureFinishers.delete(skillId);
  };
}

export function isTeachInputStopping(skillId: string): boolean {
  return stopping.has(skillId);
}

export async function stopAfterTeachInput(
  botId: string,
  skillId: string,
  stop: () => Promise<void>,
): Promise<void> {
  if (stopping.has(skillId)) return;
  stopping.add(skillId);
  try {
    captureFinishers.get(skillId)?.();
    const pending = chains.get(botId);
    if (pending) {
      const deadline = requestDeadline(STOP_DRAIN_MS, "Teaching input did not finish in time.");
      try {
        await withAbort(pending, deadline.signal);
      } catch (error) {
        // Let Stop work even when old input never answers. Late scoped packets cannot reach
        // a replacement recording; the shared chain already handles individual rejections.
        if (!deadline.signal.aborted) throw error;
      } finally {
        deadline.dispose();
      }
    }
    await stop();
  } finally {
    stopping.delete(skillId);
  }
}
