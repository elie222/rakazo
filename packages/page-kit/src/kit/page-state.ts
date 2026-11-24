import { useCallback, useRef, useSyncExternalStore } from "react";

const STATE_MESSAGE = "rakazo-page:state";
const SAVED_KEY = /^(?!__proto__$)[A-Za-z0-9_.:-]{1,64}$/;
const SEND_DELAY_MS = 400;
const OWN_CHANGE_MS = 5000;

const values = new Map<string, unknown>();
const changedAt = new Map<string, number>();
const listeners = new Set<() => void>();
let saving = false;
const unsent = new Map<string, unknown>();
let timer: ReturnType<typeof setTimeout> | undefined;

function notify() {
  for (const listener of listeners) listener();
}

function send() {
  if (unsent.size === 0) return;
  window.parent?.postMessage({ type: STATE_MESSAGE, values: Object.fromEntries(unsent) }, "*");
  unsent.clear();
}

function cooled() {
  timer = undefined;
  if (unsent.size === 0) return;
  send();
  timer = setTimeout(cooled, SEND_DELAY_MS);
}

const held = new Map<string, unknown>();
let holdTimer: ReturnType<typeof setTimeout> | undefined;

function apply(incoming: Iterable<[string, unknown]>) {
  const now = Date.now();
  let changed = false;
  let wait = Number.POSITIVE_INFINITY;
  for (const [key, value] of incoming) {
    const age = now - (changedAt.get(key) ?? Number.NEGATIVE_INFINITY);
    if (age < OWN_CHANGE_MS) {
      held.set(key, value);
      wait = Math.min(wait, OWN_CHANGE_MS - age);
      continue;
    }
    held.delete(key);
    if (JSON.stringify(values.get(key)) === JSON.stringify(value)) continue;
    values.set(key, value);
    changed = true;
  }
  if (changed) notify();
  if (wait !== Number.POSITIVE_INFINITY && holdTimer === undefined) {
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      apply([...held]);
    }, wait);
  }
}

function receive(event: MessageEvent) {
  const data = event.data as { type?: unknown; values?: unknown } | null;
  if (data?.type !== STATE_MESSAGE || !data.values || typeof data.values !== "object") return;
  apply(Object.entries(data.values));
}

export function startPageState(saved: unknown) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  saving = true;
  for (const [key, value] of Object.entries(saved)) values.set(key, value);
  addEventListener("message", receive);
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
  changedAt.set(key, Date.now());
  held.delete(key);
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
