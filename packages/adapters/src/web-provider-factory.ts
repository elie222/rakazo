import type { WebProvider } from "@rakazo/adapter-kit";
import { FakeWebProvider } from "./fake-web.js";
import { KeylessHttpWebProvider } from "./keyless-http-web.js";

/**
 * Resolve the deployment web provider.
 *
 * Pi 0.84 does not expose a provider-neutral callable native-search API we can
 * compose without vendor branches at the tool layer. Default is keyless HTTP so
 * core runs with no hosted search vendor. Inject a custom adapter (or set
 * WEB_PROVIDER=fake in tests) without changing builtin tool names.
 */
export function resolveWebProviderKind(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source.WEB_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "keyless" || raw === "keyless-http") return "keyless-http";
  if (raw === "fake") return "fake";
  return raw;
}

export function createWebProvider(
  kind: string = resolveWebProviderKind(),
  options?: ConstructorParameters<typeof KeylessHttpWebProvider>[0],
): WebProvider {
  switch (kind) {
    case "fake":
      return new FakeWebProvider();
    case "keyless-http":
    case "keyless":
    case "":
      return new KeylessHttpWebProvider(options);
    default:
      throw new Error(`Unknown web provider "${kind}"`);
  }
}
