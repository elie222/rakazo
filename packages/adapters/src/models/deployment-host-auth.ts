import type { AgentRunModel } from "@rakazo/adapter-kit";
import { deploymentHostCredentialKey } from "./deployment-model.js";
import { UnavailableModelForAuthError } from "./model-selection.js";

/** Load the selected host key and re-resolve it immediately before each provider attempt. */
export async function resolveDeploymentHostAuth(
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
): Promise<Pick<AgentRunModel, "apiKey" | "resolveApiKey"> | undefined> {
  const pendingKey = deploymentHostCredentialKey(provider, modelId);
  if (!pendingKey) return undefined;
  const apiKey = await pendingKey;
  let registeredKey = apiKey;
  return {
    apiKey,
    resolveApiKey: async (signal) => {
      const key = await deploymentHostCredentialKey(provider, modelId, signal);
      if (!key) {
        throw new UnavailableModelForAuthError(
          "The deployment model workload identity is no longer configured.",
        );
      }
      if (key !== registeredKey) {
        registerSecrets?.([key]);
        registeredKey = key;
      }
      return key;
    },
  };
}
