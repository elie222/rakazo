import { isIP } from "node:net";

const MAX_TRACKED_KEYS = 10_000;
const OVERFLOW_KEY = "\0overflow";

// Bounded without letting a flood of keys reset anyone's window: windows are kept oldest first so
// expired ones drop off the front, and keys that find the table full share one window.
export function windowCounter(windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): number => {
    const at = now();
    for (const [oldest, window] of windows) {
      if (at - window.start < windowMs) break;
      windows.delete(oldest);
    }
    const slot = windows.has(key) || windows.size < MAX_TRACKED_KEYS ? key : OVERFLOW_KEY;
    const current = windows.get(slot);
    if (current) return ++current.count;
    windows.set(slot, { start: at, count: 1 });
    return 1;
  };
}

/** What a per-address throttle counts against: an IPv6 caller's /64, which one host can hold whole. */
export function throttleKey(ip: string | undefined): string {
  if (!ip || isIP(ip) !== 6) return `ip:${ip ?? "unknown"}`;
  const [head = "", tail] = ip.replace(/%.*$/, "").split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const width = (part: string[]) =>
    part.reduce((sum, group) => sum + (group.includes(".") ? 2 : 1), 0);
  const zeros =
    tail === undefined ? [] : Array(8 - width(groups(head)) - width(groups(tail))).fill("0");
  const prefix = [...groups(head), ...zeros, ...groups(tail ?? "")].slice(0, 4);
  return `ip:${prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}
