import { fetch as undiciFetch } from "undici";

/** The fetch that must drive any `Agent` built from the `undici` package.
 *
 * Node's built-in fetch bundles its own undici, and the two diverge: undici 8
 * only accepts the current handler protocol (`onRequestStart`), so a request
 * from Node's fetch through a package `Agent` fails with "invalid
 * onRequestStart method" before a socket opens. Pairing the package's fetch
 * with its `Agent` keeps both on one version. Callers still inject a fetch
 * for tests and emulators. */
export const dispatcherFetch = undiciFetch as unknown as typeof globalThis.fetch;
