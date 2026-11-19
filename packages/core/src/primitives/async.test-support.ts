export type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

/** A promise a test holds open and settles when it chooses. */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Waits for a timer that is already due, so every promise callback queued before it has run. */
export function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
