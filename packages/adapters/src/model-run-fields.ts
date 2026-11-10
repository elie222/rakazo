import { cloudflareProviderEnv } from "./cloudflare-ai-gateway.js";
import type { StoredModelSecret } from "./model-secret.js";
import { UnavailableModelForAuthError } from "./model-selection.js";
import { assertAllowedOpenAiCompatibleUrl } from "./openai-compatible-url.js";

/**
 * What a stored key or endpoint adds to a run besides the key, a member's or the deployment's.
 * Private endpoints are checked against this deployment's policy on every run.
 */
export function storedSecretRunFields(
  deps: { mcpAllowPrivateEndpoint?: boolean },
  provider: string,
  secret: StoredModelSecret,
  acceptsImages: boolean | undefined,
) {
  const compatible = secret.kind === "openai_compatible" ? secret : undefined;
  const baseUrl = compatible?.baseUrl;
  const allowPrivateEndpoint = baseUrl ? deps.mcpAllowPrivateEndpoint === true : undefined;
  if (baseUrl) {
    try {
      // The public gate stays with the request-time fetch guard.
      assertAllowedOpenAiCompatibleUrl(baseUrl, {
        allowPublic: true,
        allowPrivate: allowPrivateEndpoint,
      });
    } catch (error) {
      throw new UnavailableModelForAuthError((error as Error).message);
    }
  }
  const accountId = secret.kind === "api_key" ? secret.accountId : undefined;
  const gatewayId = secret.kind === "api_key" ? secret.gatewayId : undefined;
  cloudflareProviderEnv({ provider, accountId, gatewayId });
  return {
    accountId,
    gatewayId,
    baseUrl,
    apiProtocol: compatible?.apiProtocol,
    headers: compatible?.headers,
    allowPrivateEndpoint,
    cacheCapabilities: secret.kind !== "oauth" ? secret.cacheCapabilities : undefined,
    contextWindow: secret.kind !== "oauth" ? secret.contextWindow : undefined,
    reasoning: compatible?.reasoning,
    maxTokens: secret.maxTokens,
    thinkingLevel: compatible?.thinkingLevel,
    acceptsImages,
    maxImagesPerPrompt: compatible?.maxImagesPerPrompt,
  };
}
