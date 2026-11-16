import { cloudflareProviderEnv } from "./cloudflare-ai-gateway.js";
import type { StoredModelSecret } from "./model-secret.js";
import { UnavailableModelForAuthError } from "./model-selection.js";
import { connectionModelSettings } from "./model-settings.js";
import { assertAllowedOpenAiCompatibleUrl } from "./openai-compatible-url.js";

/**
 * What a stored key or endpoint adds to a run besides the key, a member's or the deployment's.
 * Private endpoints are checked against this deployment's policy on every run.
 */
export function storedSecretRunFields(
  deps: { mcpAllowPrivateEndpoint?: boolean },
  provider: string,
  modelId: string,
  secret: StoredModelSecret,
  context: {
    /** The member's connection row, whose legacy image answer still applies to its model. */
    credential?: Parameters<typeof connectionModelSettings>[3];
    /** What an account's live catalog says the model reads, which outranks its settings. */
    liveImages?: boolean;
  } = {},
) {
  const compatible = secret.kind === "openai_compatible" ? secret : undefined;
  const baseUrl = compatible?.baseUrl;
  // Recheck operator configuration for saved private connections on every run.
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
  const settings = connectionModelSettings(secret, provider, modelId, context.credential);
  const apiKey = secret.kind === "api_key" ? secret : undefined;
  cloudflareProviderEnv({ provider, accountId: apiKey?.accountId, gatewayId: apiKey?.gatewayId });
  return {
    accountId: apiKey?.accountId,
    gatewayId: apiKey?.gatewayId,
    projectId: apiKey?.projectId,
    region: apiKey?.region,
    baseUrl,
    apiProtocol: compatible?.apiProtocol,
    headers: compatible?.headers,
    allowPrivateEndpoint,
    cacheCapabilities: secret.kind !== "oauth" ? secret.cacheCapabilities : undefined,
    contextWindow: settings.contextWindow,
    reasoning: settings.reasoning,
    maxTokens: settings.maxTokens,
    // The account catalog knows what a Codex model reads; elsewhere the model's setting
    // decides wherever the bundled catalog cannot.
    acceptsImages: context.liveImages ?? settings.images,
    maxImagesPerPrompt: settings.maxImagesPerPrompt,
  };
}
