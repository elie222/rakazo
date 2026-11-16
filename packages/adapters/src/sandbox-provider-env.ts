import type {
  SandboxProviderOptions,
  SandboxSettingOption,
} from "./computer-provider-descriptor.js";
import { envBindings, optional } from "./computer-provider-descriptor.js";
import { computerProviders, isKnownSandboxKind } from "./computer-providers.js";

/** Empty or remote provider without a key becomes none so services can boot for signup. */
export function resolveSandboxProvider(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.SANDBOX_PROVIDER;
  if (configured !== undefined && !configured.trim()) return "none";
  const requested = configured?.trim() || "docker";
  if (!isKnownSandboxKind(requested)) return requested;
  const provider = computerProviders[requested];
  const missing = envBindings(provider).some(
    ([, binding]) => binding.required && !optional(source[binding.name]),
  );
  return missing || provider.unavailable?.(source) ? "none" : requested;
}

export function sandboxProviderOptionsFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): Pick<SandboxProviderOptions, SandboxSettingOption | "hostComputerUrl" | "hostComputerToken"> {
  const options: Record<string, unknown> = {
    hostComputerUrl: source.SANDBOX_HOST_URL,
    hostComputerToken: source.SANDBOX_HOST_TOKEN,
  };
  for (const provider of Object.values(computerProviders)) {
    for (const [option, binding] of envBindings(provider)) {
      options[option] = (binding.read ?? optional)(source[binding.name], source);
    }
  }
  return options;
}
