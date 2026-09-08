import { fetch as undiciFetch } from "undici";

/** Captured before tests replace `globalThis.fetch` via stubs. */
const nodeBuiltinFetch = globalThis.fetch;

/**
 * Node's global fetch is backed by undici 6.x while @rakazo/adapters pins undici 8.x
 * for Agent dispatchers. Passing an undici 8 Agent to global fetch throws
 * UND_ERR_INVALID_ARG; use undici's fetch whenever a custom dispatcher is required.
 */
export function fetchCompatibleWithUndiciAgent(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return baseFetch === nodeBuiltinFetch
    ? (undiciFetch as unknown as typeof globalThis.fetch)
    : baseFetch;
}
