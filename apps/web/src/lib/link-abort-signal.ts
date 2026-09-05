/** Subscribe to `source` abort, or run immediately if it already aborted. */
export function linkAbortSignal(source: AbortSignal, onAbort: () => void): () => void {
  if (source.aborted) {
    onAbort();
    return () => {};
  }
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}
