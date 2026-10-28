/**
 * A transaction that waits on a provider (an integration, a payment processor) keeps its
 * pooled connection for the whole call, and every caller queued on a lock it holds keeps
 * one too. When the provider hangs, a few of them take every connection in the process,
 * and sign-in and every other request time out waiting for one. They run one at a time
 * per process instead: the rest wait here, without a connection.
 */
export class ProviderTransactionBusyError extends Error {
  constructor() {
    super("Try again in a moment.");
    this.name = "ProviderTransactionBusyError";
  }
}

export interface ProviderTransactionGate {
  /** Runs `fn` once a slot is free, or throws ProviderTransactionBusyError after `waitMs`. */
  run<T>(fn: () => Promise<T>, waitMs: number): Promise<T>;
}

export function createProviderTransactionGate(slots: number): ProviderTransactionGate {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (waitMs: number) =>
    new Promise<void>((resolve, reject) => {
      if (active < slots) {
        active += 1;
        resolve();
        return;
      }
      const waiter = () => {
        clearTimeout(timer);
        active += 1;
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new ProviderTransactionBusyError());
      }, waitMs);
      waiters.push(waiter);
    });

  const release = () => {
    active -= 1;
    waiters.shift()?.();
  };

  return {
    async run(fn, waitMs) {
      await acquire(waitMs);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

// One slot: a transaction that also queries outside it needs a second connection, so this
// leaves the rest of even the smallest pool to everything else.
const gate = createProviderTransactionGate(1);

export function runProviderTransaction<T>(fn: () => Promise<T>, waitMs: number): Promise<T> {
  return gate.run(fn, waitMs);
}
