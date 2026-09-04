import type { CloudAgentProvider } from "@rakazo/adapter-kit";
import { EmulatorCloudAgentProvider } from "./cloud-agent-emulator.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { CursorCloudAgentProvider } from "./cursor-cloud-agent.js";

export interface CloudAgentProviderOptions {
  cursorApiKey?: string;
  cursorBaseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Build the deployment cloud-agent provider. Returns null for none so callers
 * skip tool injection. Cursor without a key resolves to none upstream.
 */
export function createCloudAgentProvider(
  kind: string = resolveCloudAgentProvider(),
  options: CloudAgentProviderOptions = {},
): CloudAgentProvider | null {
  switch (kind) {
    case "none":
    case "":
      return null;
    case "emulator":
    case "fake":
      return new EmulatorCloudAgentProvider();
    case "cursor": {
      const apiKey = options.cursorApiKey ?? process.env.CURSOR_API_KEY;
      if (!apiKey?.trim()) return null;
      return new CursorCloudAgentProvider({
        apiKey,
        baseUrl: options.cursorBaseUrl,
        fetch: options.fetch,
      });
    }
    default:
      return null;
  }
}
