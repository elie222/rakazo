import { useCallback, useRef, useSyncExternalStore } from "react";

const STATE_MESSAGE = "rakazo-page:state";
const SAVED_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const SEND_DELAY_MS = 400;
const OWN_CHANGE_MS = 5000;

const values = new Map<string, unknown>();
const changedAt = new Map<string, number>();
const listeners = new Set<() => void>();
let saving = false;
let unsent: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | undefined;

function notify() {
  for (const listener of listeners) listener();
}

function send() {
  timer = undefined;
  const batch = unsent;
  unsent = {};
  if (Object.keys(batch).length > 0) {
    window.parent?.postMessage({ type: STATE_MESSAGE, values: batch }, "*");
  }
}

function receive(event: MessageEvent) {
  const data = event.data as { type?: unknown; values?: unknown } | null;
  if (data?.type !== STATE_MESSAGE || !data.values || typeof data.values !== "object") return;
  const now = Date.now();
  let changed = false;
  for (const [key, value] of Object.entries(data.values)) {
    if (now - (changedAt.get(key) ?? Number.NEGATIVE_INFINITY) < OWN_CHANGE_MS) continue;
    if (JSON.stringify(values.get(key)) === JSON.stringify(value)) continue;
    values.set(key, value);
    changed = true;
  }
  if (changed) notify();
}

export function startPageState(saved: unknown) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  saving = true;
  for (const [key, value] of Object.entries(saved)) values.set(key, value);
  addEventListener("message", receive);
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
  unsent[key] = saved;
  if (timer === undefined) timer = setTimeout(send, SEND_DELAY_MS);
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
