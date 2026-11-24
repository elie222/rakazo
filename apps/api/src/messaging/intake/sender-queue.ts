/**
 * One sender's work, one task at a time and in the order it arrived, in this process; other
 * senders' work runs alongside. A task that fails does not hold up the next: its caller gets the
 * failure, and the queue only waits for it to settle.
 */
export function createSenderQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const result = (tails.get(key) ?? Promise.resolve()).then(task);
      const tail = Promise.allSettled([result]);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    /** Whether this sender has work queued or running here. */
    busy(key: string): boolean {
      return tails.has(key);
    },
  };
}

export type SenderQueue = ReturnType<typeof createSenderQueue>;
