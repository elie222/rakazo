import type { AsyncLocalStorage } from "node:async_hooks";
import type { LogBindings } from "./types.js";

// Loaded at runtime so React Native and browser bundles, which have no async context and carry
// no bindings, never resolve a Node built-in.
const storage: AsyncLocalStorage<LogBindings> | undefined = (() => {
  const asyncHooks = globalThis.process?.getBuiltinModule?.("node:async_hooks");
  return asyncHooks ? new asyncHooks.AsyncLocalStorage<LogBindings>() : undefined;
})();

export function getLogContext(): LogBindings {
  return { ...(storage?.getStore() ?? {}) };
}

export function runWithLogContext<T>(bindings: LogBindings, fn: () => T): T {
  if (!storage) return fn();
  return storage.run({ ...storage.getStore(), ...bindings }, fn);
}

export function enrichLogContext(bindings: LogBindings): void {
  const store = storage?.getStore();
  if (!store) return;
  Object.assign(store, bindings);
}
