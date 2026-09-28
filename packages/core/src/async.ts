export async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
    // Abort can land between the check above and the listener; resolve now rather
    // than waiting out the full delay (or hanging if the event already fired).
    if (signal?.aborted) finish();
  });
}
