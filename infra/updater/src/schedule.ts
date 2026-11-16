/** A restart waits a full interval, and long-running updates never overlap scheduled checks. */
export function startUpdateSchedule(
  intervalMs: number,
  update: () => Promise<void>,
  onError: (error: unknown) => void,
): () => Promise<void> {
  if (intervalMs === 0) return async () => {};
  let stopped = false;
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout>;
  async function check() {
    try {
      await update();
    } catch (error) {
      onError(error);
    } finally {
      pending = null;
      if (!stopped) schedule();
    }
  }
  function schedule() {
    timer = setTimeout(() => {
      pending = check();
    }, intervalMs);
    timer.unref();
  }
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
