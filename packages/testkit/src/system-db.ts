import { runAsSystem } from "@rakazo/db";

/**
 * The same client with every call run as an explicit system context. Integration
 * suites connect as the runtime login, so their own fixtures and assertions, which
 * have no request or job around them, would otherwise see no protected rows. App
 * code under test keeps the context the request or job gives it.
 */
export function asSystem<T extends object>(client: T, reason = "test fixture"): T {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          runAsSystem(reason, () => Reflect.apply(value, target, args));
      }
      if (value && typeof value === "object") return asSystem(value, reason);
      return value;
    },
  });
}
