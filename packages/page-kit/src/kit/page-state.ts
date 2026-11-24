import { useCallback, useRef, useSyncExternalStore } from "react";

const STATE_MESSAGE = "rakazo-page:state";
const SAVED_KEY = /^(?!__proto__$)[A-Za-z0-9_.:-]{1,64}$/;
const SEND_DELAY_MS = 400;
const SEND_MAX_KEYS = 100;

const values = new Map<string, unknown>();
const listeners = new Set<() => void>();
let saving = false;
const unsent = new Map<string, unknown>();
let timer: ReturnType<typeof setTimeout> | undefined;

function notify() {
  for (const listener of listeners) listener();
}

function send() {
  const entries = [...unsent];
  unsent.clear();
  for (let start = 0; start < entries.length; start += SEND_MAX_KEYS) {
    const values = Object.fromEntries(entries.slice(start, start + SEND_MAX_KEYS));
    window.parent?.postMessage({ type: STATE_MESSAGE, values }, "*");
  }
}

function cooled() {
  timer = undefined;
  if (unsent.size === 0) return;
  send();
  timer = setTimeout(cooled, SEND_DELAY_MS);
}

/** The values the host saved for this reader; without them the page saves nothing. */
export function startPageState(saved: unknown) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  saving = true;
  for (const [key, value] of Object.entries(saved)) values.set(key, value);
  addEventListener("pagehide", send);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") send();
  });
}

function asJson(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function setValue(key: string, value: unknown) {
  values.set(key, value);
  notify();
  if (!saving || !SAVED_KEY.test(key)) return;
  const saved = asJson(value);
  if (saved === undefined) return;
  unsent.set(key, saved);
  if (timer !== undefined) return;
  send();
  timer = setTimeout(cooled, SEND_DELAY_MS);
}

function sameShape(saved: unknown, initial: unknown): boolean {
  if (initial === null || initial === undefined) return true;
  if (saved === null || saved === undefined) return false;
  return Array.isArray(saved) === Array.isArray(initial) && typeof saved === typeof initial;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePageState<T>(
  key: string,
  initial: T,
): [T, (next: T | ((current: T) => T)) => void] {
  const name = String(key);
  const fallback = useRef(initial);
  fallback.current = initial;
  const read = () => values.get(name);
  const stored = useSyncExternalStore(subscribe, read, read);
  const value = values.has(name) && sameShape(stored, initial) ? (stored as T) : initial;
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      const saved = values.get(name);
      const current =
        values.has(name) && sameShape(saved, fallback.current) ? (saved as T) : fallback.current;
      setValue(name, typeof next === "function" ? (next as (current: T) => T)(current) : next);
    },
    [name],
  );
  return [value, set];
}
