import type { WebProvider } from "@rakazo/adapter-kit";
import { BraveWebProvider } from "./brave-web.js";
import { FakeWebProvider } from "./fake-web.js";
import { FallbackWebProvider } from "./fallback-web.js";
import { KeenableWebProvider } from "./keenable-web.js";
import { KeylessHttpWebProvider } from "./keyless-http-web.js";
import { ParallelWebProvider } from "./parallel-web.js";
import { TavilyWebProvider } from "./tavily-web.js";

type WebProviderOptions = ConstructorParameters<typeof KeylessHttpWebProvider>[0];

/**
 * Pi 0.84 exposes no provider-neutral native-search API, so the default is keyless HTTP and core
 * runs with no hosted search vendor. An empty result means "no explicit choice": the caller
 * builds the default chain instead of a single provider.
 */
export function resolveWebProviderKind(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.WEB_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "keyless" || raw === "keyless-http") return raw ? "keyless-http" : "";
  if (raw === "fake") return "fake";
  return raw;
}

/** One provider by kind. "fallback" and "" are handled by the caller, not here. */
function createSingleProvider(kind: string, options?: WebProviderOptions): WebProvider {
  switch (kind) {
    case "parallel":
      return new ParallelWebProvider(options);
    case "keenable":
      return new KeenableWebProvider(options);
    case "fake":
      return new FakeWebProvider();
    case "tavily":
      return new TavilyWebProvider({
        fetch: options?.fetch,
        searchTimeoutMs: options?.searchTimeoutMs,
        fetchTimeoutMs: options?.fetchTimeoutMs,
      });
    case "brave":
      return new BraveWebProvider({
        fetch: options?.fetch,
        resolveHostname: options?.resolveHostname,
        searchTimeoutMs: options?.searchTimeoutMs,
        fetchTimeoutMs: options?.fetchTimeoutMs,
        maxBufferBytes: options?.maxBufferBytes,
      });
    case "keyless-http":
    case "keyless":
      return new KeylessHttpWebProvider(options);
    default:
      throw new Error(`Unknown web provider "${kind}"`);
  }
}

/**
 * The default chain: API providers with keys first, keyless HTTP last. When no
 * API key is set the chain is just keyless HTTP, the previous default. A chain
 * of one is returned unwrapped, so the default provider id stays "keyless-http"
 * until a key is configured.
 */
export function defaultWebProviderChain(source: NodeJS.ProcessEnv = process.env): WebProvider[] {
  const chain: WebProvider[] = [];
  if (source.TAVILY_API_KEY?.trim()) chain.push(new TavilyWebProvider());
  if (source.BRAVE_API_KEY?.trim()) chain.push(new BraveWebProvider());
  chain.push(new KeylessHttpWebProvider());
  return chain;
}

function wrapChain(chain: WebProvider[]): WebProvider {
  return chain.length === 1 ? chain[0]! : new FallbackWebProvider(chain);
}

/**
 * Compose the web backend. WEB_PROVIDER may name one provider ("tavily"), a
 * comma-separated chain ("tavily,brave,keyless-http"), or "fallback" for the
 * default chain. With no WEB_PROVIDER set, the default chain applies: API
 * providers with keys first, keyless HTTP last.
 */
export function createWebProvider(
  kind: string = resolveWebProviderKind(),
  options?: WebProviderOptions,
): WebProvider {
  const kinds = kind
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (kinds.length === 0 || kinds[0] === "fallback") {
    return wrapChain(defaultWebProviderChain());
  }
  if (kinds.length === 1) return createSingleProvider(kinds[0]!, options);
  return new FallbackWebProvider(kinds.map((entry) => createSingleProvider(entry, options)));
}
