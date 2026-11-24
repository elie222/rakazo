/**
 * Bytes this process holds in memory for chat-app files being downloaded: each download reserves
 * what it may take before it starts and gives it back once it has settled, however long its
 * caller waited for it. Reservations are granted in arrival order, so a large one is not starved
 * by smaller ones behind it, and one larger than the whole budget is clamped and runs alone.
 */
export function createDownloadBudget(totalBytes: number) {
  let free = totalBytes;
  const waiting: Array<{ bytes: number; grant: () => void }> = [];
  const drain = () => {
    for (let next = waiting[0]; next && next.bytes <= free; next = waiting[0]) {
      waiting.shift();
      free -= next.bytes;
      next.grant();
    }
  };
  return {
    /**
     * Resolves with a release function once `bytes` fit in what is left. Rejects, without
     * holding anything, once `signal` aborts while it waits.
     */
    async acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
      signal?.throwIfAborted();
      const need = Math.min(bytes, totalBytes);
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const at = waiting.indexOf(entry);
          if (at === -1) return;
          waiting.splice(at, 1);
          reject(signal?.reason);
          // What it queued ahead of may now fit.
          drain();
        };
        const entry = {
          bytes: need,
          grant: () => {
            signal?.removeEventListener("abort", onAbort);
            let released = false;
            resolve(() => {
              if (released) return;
              released = true;
              free += need;
              drain();
            });
          },
        };
        waiting.push(entry);
        signal?.addEventListener("abort", onAbort, { once: true });
        drain();
      });
    },
  };
}

export type DownloadBudget = ReturnType<typeof createDownloadBudget>;
