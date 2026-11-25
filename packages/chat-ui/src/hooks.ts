import type { MobileDeviceSummary } from "@rakazo/contracts";
import type { ListSearchOptions } from "@rakazo/core";
import { listSearch } from "@rakazo/core";
import { useEffect, useEffectEvent, useState } from "react";

/**
 * Calls `callback` once, `ms` after mount. A new `ms` or `restartKey` starts the wait again and
 * `null` cancels it; the latest callback runs, and nothing runs after unmount.
 */
export function useTimeout(callback: () => void, ms: number | null, restartKey?: unknown): void {
  const fire = useEffectEvent(callback);
  useEffect(() => {
    if (ms === null) return;
    const timer = setTimeout(() => fire(), ms);
    return () => clearTimeout(timer);
  }, [ms, restartKey]);
}

/** `Date.now()`, refreshed every `ms` while it is not `null` and at once when it resumes. */
export function useNow(ms: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (ms === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** Apply the server's presence and sign-in deadlines locally, without a timed RPC read. */
export function useMobileDeviceRows(phones: MobileDeviceSummary[] | undefined, visible = true) {
  const now = useNow(visible && phones?.length ? 1_000 : null);
  return phones
    ?.filter((phone) => !phone.sessionExpiresAt || Date.parse(phone.sessionExpiresAt) > now)
    .map((phone) => ({
      ...phone,
      connected: phone.connected && Date.parse(phone.onlineUntil) > now,
    }));
}

/** A list filtered by a search box's query, with the query state the box binds to. */
export function useListSearch<T>(items: readonly T[], options: ListSearchOptions<T>) {
  const [query, setQuery] = useState("");
  return { query, setQuery, ...listSearch(items, query, options) };
}
