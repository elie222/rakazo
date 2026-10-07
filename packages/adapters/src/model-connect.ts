import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelConnectInput, ModelCredential, ThinkingLevel } from "@rakazo/contracts";
import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  OPENAI_COMPATIBLE_PROVIDER_ID as CONTRACT_OPENAI_COMPAT,
  cloudflareGatewayRouting,
  isCloudflareAiGatewayProvider,
  modelOutputLeavesInputRoom,
} from "@rakazo/contracts";
import { modelIdSupportsImages, updateModelImageCapabilities } from "./model-vision.js";
import {
  CHATGPT_OAUTH_PROVIDER,
  parseModelSecret,
  type StoredModelSecret,
  serializeModelSecret,
} from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleModel,
  prepareOpenAiCompatibleConnect,
} from "./pi-openai-compatible-provider.js";

export type BuildModelConnectOptions = {
  /** Skip writing visionModelIds when prior plaintext was unavailable during key replacement. */
  omitVisionModelIds?: boolean;
};

export function buildModelConnectPlaintext(
  input: ModelConnectInput,
  previousPlaintext?: string,
  options?: BuildModelConnectOptions,
): string {
  const previous = tryParseModelSecret(previousPlaintext);
  const inherited = previous?.kind === "api_key" ? previous : undefined;
  const cacheCapabilities = input.cacheCapabilities ?? inherited?.cacheCapabilities;
  const contextWindow = input.contextWindow ?? inherited?.contextWindow;
  const limits = {
    ...(cacheCapabilities !== undefined ? { cacheCapabilities } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const prepared = prepareOpenAiCompatibleConnect(input);
    const sameEndpoint =
      previous?.kind === "openai_compatible" && previous.baseUrl === prepared.baseUrl;
    const compatiblePrevious = sameEndpoint ? previous : undefined;
    if (input.apiKey === undefined && sameEndpoint) {
      // Revalidate the inherited key too: public endpoints must still use HTTPS.
      prepared.apiKey = prepareOpenAiCompatibleConnect({
        ...input,
        apiKey: previous.apiKey,
      }).apiKey;
    }
    const previousVisionModelIds = sameEndpoint ? previous.visionModelIds : undefined;
    const maxImagesPerPrompt =
      input.maxImagesPerPrompt === null
        ? undefined
        : (input.maxImagesPerPrompt ?? (sameEndpoint ? previous.maxImagesPerPrompt : undefined));
    const thinkingLevel =
      input.thinkingLevel !== undefined
        ? input.thinkingLevel
        : sameEndpoint
          ? previous.thinkingLevel
          : undefined;
    const maxTokens = connectMaxTokens(
      input.maxTokens,
      sameEndpoint ? previous.maxTokens : undefined,
    );
    const contextWindow =
      input.contextWindow !== undefined
        ? input.contextWindow
        : sameEndpoint
          ? previous.contextWindow
          : undefined;
    if (!modelOutputLeavesInputRoom(maxTokens, contextWindow)) {
      throw new Error("Maximum output tokens must leave room for input");
    }
    const visionModelIds = updateModelImageCapabilities(
      previousVisionModelIds,
      prepared.modelId,
      input.supportsImages,
    );
    const includeVisionModelIds =
      !options?.omitVisionModelIds &&
      (input.supportsImages !== undefined || previousVisionModelIds !== undefined);
    const compatibleCacheCapabilities =
      input.cacheCapabilities ?? compatiblePrevious?.cacheCapabilities;
    const secret: StoredModelSecret = {
      kind: "openai_compatible",
      baseUrl: prepared.baseUrl,
      ...(compatibleCacheCapabilities !== undefined
        ? { cacheCapabilities: compatibleCacheCapabilities }
        : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(prepared.apiKey ? { apiKey: prepared.apiKey } : {}),
      ...(includeVisionModelIds ? { visionModelIds } : {}),
      ...(maxImagesPerPrompt !== undefined ? { maxImagesPerPrompt } : {}),
    };
    return serializeModelSecret(secret);
  }
  const apiKey = input.apiKey?.trim();
  // The Codex transport authenticates with the OAuth JWT from ChatGPT sign-in,
  // which carries the chatgpt account id it requires. A plain API key can never
  // work there, so reject it instead of persisting a credential that only fails
  // at request time.
  if (input.provider === CHATGPT_OAUTH_PROVIDER && apiKey) {
    throw new Error(CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE);
  }
  const maxTokens = connectMaxTokens(input.maxTokens, previous?.maxTokens);
  if (!modelOutputLeavesInputRoom(maxTokens, contextWindow)) {
    throw new Error("Maximum output tokens must leave room for input");
  }
  const routing = cloudflareRoutingForConnect(input, previous);
  if (apiKey) {
    if (apiKey.length < 8) throw new Error("API key must contain at least 8 characters");
    return serializeModelSecret({
      kind: "api_key",
      key: apiKey,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...limits,
      ...routing,
    });
  }
  if (previous?.kind === "api_key" && previous.key.trim().length >= 8) {
    if (input.provider === CHATGPT_OAUTH_PROVIDER) {
      throw new Error(CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE);
    }
    return serializeModelSecret({
      kind: "api_key",
      key: previous.key,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...limits,
      ...routing,
    });
  }
  if (previous?.kind === "oauth") {
    return serializeModelSecret({
      kind: "oauth",
      credential: previous.credential,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
  }
  if (input.provider === CHATGPT_OAUTH_PROVIDER) {
    throw new Error(CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE);
  }
  throw new Error("API key must contain at least 8 characters");
}

const CHATGPT_SUBSCRIPTION_REQUIRED_MESSAGE =
  "ChatGPT subscription sign-in is required for this provider.";

/** Inherited fields come from the previous secret; a corrupt one counts as absent. */
function tryParseModelSecret(plaintext?: string): StoredModelSecret | undefined {
  if (!plaintext) return undefined;
  try {
    return parseModelSecret(plaintext);
  } catch {
    return undefined;
  }
}

/**
 * Cloudflare AI Gateway routing is part of the saved key. Omitted fields keep
 * the previous connection's ids; a blank or unsafe value is rejected.
 */
function cloudflareRoutingForConnect(
  input: ModelConnectInput,
  previous: ReturnType<typeof tryParseModelSecret>,
): { accountId: string; gatewayId: string } | undefined {
  if (!isCloudflareAiGatewayProvider(input.provider)) return undefined;
  const accountId =
    input.accountId !== undefined
      ? input.accountId
      : previous?.kind === "api_key"
        ? previous.accountId
        : undefined;
  const gatewayId =
    input.gatewayId !== undefined
      ? input.gatewayId
      : previous?.kind === "api_key"
        ? previous.gatewayId
        : undefined;
  const routing = cloudflareGatewayRouting({ accountId, gatewayId });
  if (!routing) throw new Error(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
  return routing;
}

/**
 * Whether the stored secret contains an API key. OAuth sign-in and a keyless
 * OpenAI-compatible server are connections without one. An unreadable secret
 * is not reported as a key — the client must not invent a stored-key state.
 */
function storedModelSecretHasApiKey(plaintext: string | undefined): boolean {
  if (!plaintext) return false;
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind === "api_key") return parsed.key.trim().length > 0;
  if (parsed.kind === "openai_compatible") return Boolean(parsed.apiKey?.trim());
  return false;
}

/** `null` clears a saved limit. Omitting it keeps the previous connection's limit. */
function connectMaxTokens(
  input: number | null | undefined,
  previous: number | undefined,
): number | undefined {
  if (input === null) return undefined;
  if (input !== undefined) return input;
  return previous;
}

export function modelCredentialDto(
  row: {
    id: string;
    provider: string;
    label: string;
    isDefault: boolean;
    defaultModel?: string | null;
    thinkingLevel?: string | null;
    supportsImages?: boolean;
  },
  plaintext?: string,
): ModelCredential {
  const credential: ModelCredential = {
    id: row.id,
    provider: row.provider,
    label: row.label,
    hasKey: storedModelSecretHasApiKey(plaintext),
    isDefault: row.isDefault,
    ...(row.defaultModel ? { modelId: row.defaultModel } : {}),
    // Space-scoped effort stored beside the preference's modelId; the
    // openai-compatible secret may still contribute below when unset.
    ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel as ThinkingLevel } : {}),
  };
  if (row.provider !== CONTRACT_OPENAI_COMPAT) {
    if (!plaintext) return credential;
    const parsed = parseModelSecret(plaintext);
    return {
      ...credential,
      ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
      ...(parsed.kind !== "oauth"
        ? {
            cacheCapabilities: parsed.cacheCapabilities,
            contextWindow: parsed.contextWindow,
          }
        : {}),
      ...(parsed.kind === "api_key" && parsed.accountId ? { accountId: parsed.accountId } : {}),
      ...(parsed.kind === "api_key" && parsed.gatewayId ? { gatewayId: parsed.gatewayId } : {}),
    };
  }
  const compatibleCredential = {
    ...credential,
    supportsImages: row.supportsImages ?? false,
  };
  if (!plaintext) return compatibleCredential;
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind !== "openai_compatible") return compatibleCredential;
  return {
    ...compatibleCredential,
    supportsImages:
      parsed.visionModelIds !== undefined
        ? modelIdSupportsImages(parsed.visionModelIds, row.defaultModel)
        : compatibleCredential.supportsImages,
    baseUrl: parsed.baseUrl,
    reasoning: parsed.reasoning ?? false,
    ...(credential.thinkingLevel !== undefined || parsed.thinkingLevel !== undefined
      ? { thinkingLevel: credential.thinkingLevel ?? parsed.thinkingLevel }
      : {}),
    ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
    ...(parsed.contextWindow !== undefined ? { contextWindow: parsed.contextWindow } : {}),
    cacheCapabilities: parsed.cacheCapabilities,
    ...(parsed.maxImagesPerPrompt !== undefined
      ? { maxImagesPerPrompt: parsed.maxImagesPerPrompt }
      : {}),
    thinkingLevels: getSupportedThinkingLevels(
      openAiCompatibleModel(row.defaultModel ?? "custom", parsed.baseUrl, parsed.reasoning),
    ) as ThinkingLevel[],
    modelId: row.defaultModel ?? undefined,
  };
}
