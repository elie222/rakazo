const HOUR_MS = 60 * 60 * 1000;

/** Runs the sweep at startup and hourly; every API instance may run it, so sweeps claim their work. */
export function startHourlySweep(sweep: () => Promise<void>, onError: (error: unknown) => void) {
  let running: Promise<void> | undefined;
  const tick = () => {
    running ??= sweep()
      .catch(onError)
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, HOUR_MS);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
