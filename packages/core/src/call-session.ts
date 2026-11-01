/** One line of a call's transcript. */
export type CallExchange = { role: "user" | "bot"; text: string };

/** How long a goodbye waits for a reply that may never come before hanging up anyway. */
export const CALL_FAREWELL_TIMEOUT_MS = 20_000;

/**
 * The turns a call has sent and not yet seen land. The server checks durable user
 * messages when a call closes, so a hang-up must follow every write still in flight.
 */
export function createCallSendTracker() {
  const pending = new Map<string, Set<Promise<unknown>>>();
  return {
    /** Holds `callId`'s close until `request` settles; the returned release forgets it. */
    track(callId: string, request: Promise<unknown>): () => void {
      const sends = pending.get(callId) ?? new Set<Promise<unknown>>();
      sends.add(request);
      pending.set(callId, sends);
      return () => {
        sends.delete(request);
        if (sends.size === 0) pending.delete(callId);
      };
    },
    /**
     * Runs `close` now, or once `callId`'s in-flight sends settle. Failures are dropped; the
     * returned promise settles when `close` does.
     */
    closeAfterSends(callId: string, close: () => Promise<unknown>): Promise<void> {
      const sends = [...(pending.get(callId) ?? [])];
      const closed = sends.length === 0 ? close() : Promise.allSettled(sends).then(close);
      return closed.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
