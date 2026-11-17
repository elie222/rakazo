import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { SandboxProviderOptions } from "./computer-provider-descriptor.js";
import { envBindings } from "./computer-provider-descriptor.js";
import { computerProviders, isKnownSandboxKind, knownSandboxKinds } from "./computer-providers.js";
import { NoneSandboxProvider } from "./providers/computer/none/none-sandbox.js";

export type { SandboxProviderOptions } from "./computer-provider-descriptor.js";

export async function createSandboxProvider(
  kind: string,
  opts: SandboxProviderOptions,
): Promise<SandboxProvider> {
  if (kind === "") return new NoneSandboxProvider();
  if (!isKnownSandboxKind(kind)) {
    throw new Error(`Unknown SANDBOX_PROVIDER "${kind}". Use ${knownSandboxKinds.join(" | ")}.`);
  }
  const provider = computerProviders[kind];
  const missing = envBindings(provider).find(
    ([option, binding]) => binding.required && !(opts[option] as string | undefined)?.trim(),
  );
  if (missing) {
    return new NoneSandboxProvider(
      `Computers unavailable: ${missing[1].name} is required for SANDBOX_PROVIDER=${kind}.`,
    );
  }
  return provider.create(opts);
}
