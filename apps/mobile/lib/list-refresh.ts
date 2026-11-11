/** What one read of a list found. */
export type ListRead<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * The only way a screen reads its list. A request always leads to a read sent after it, and one
 * read is out at a time: requests made while one is out lead to one more read once it answers.
 * A read's answer, or its failure, is applied only when neither the vault it was sent for nor the
 * screen's change counter moved while it was out, and the screen was not left meanwhile;
 * otherwise it is dropped and read again. While the screen is away nothing is read or applied:
 * requests wait until it is shown again.
 */
export function createListRefresh<T>(options: {
  vault: () => string;
  changes: () => number;
  read: (vault: string) => Promise<T>;
  apply: (read: ListRead<T>) => void;
}) {
  let dirty = false;
  let running = false;
  let shown = false;
  // Counts the times the screen was left, so a read sent before it was left is never applied.
  let visits = 0;

  async function loop() {
    running = true;
    while (dirty && shown) {
      dirty = false;
      const vault = options.vault();
      const changes = options.changes();
      const visit = visits;
      let read: ListRead<T>;
      try {
        read = { ok: true, value: await options.read(vault) };
      } catch (error) {
        read = { ok: false, error };
      }
      if (!shown) break;
      if (visits !== visit || options.vault() !== vault || options.changes() !== changes)
        dirty = true;
      else options.apply(read);
    }
    running = false;
  }

  function request() {
    dirty = true;
    if (shown && !running) void loop();
  }

  return {
    request,
    /** The screen is shown: reads what was requested while it was away, and the list afresh. */
    start() {
      shown = true;
      request();
    },
    /** The screen is away or gone: the read that is out is dropped. */
    stop() {
      shown = false;
      visits += 1;
    },
  };
}
