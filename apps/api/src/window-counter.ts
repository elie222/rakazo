const MAX_TRACKED_KEYS = 10_000;

// Bounded: when the table fills it starts over.
export function windowCounter(windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): number => {
    const at = now();
    const current = windows.get(key);
    if (current && at - current.start < windowMs) return ++current.count;
    if (windows.size >= MAX_TRACKED_KEYS) windows.clear();
    windows.set(key, { start: at, count: 1 });
    return 1;
  };
}
