/**
 * Runs each piece of work after the one before has settled. Installs, removals and refreshes
 * share the registry, the token files and the folders they write, so they never overlap.
 */
export function createOneAtATime() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    // The caller gets the failure; the next one waits only for this one to settle.
    queue = Promise.allSettled([next]);
    return next;
  };
}
