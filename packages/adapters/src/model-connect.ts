import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelConnectInput, ModelCredential, ThinkingLevel } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID as CONTRACT_OPENAI_COMPAT } from "@rakazo/contracts";
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
  if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const prepared = prepareOpenAiCompatibleConnect(input);
    const previous = tryParseModelSecret(previousPlaintext);
    const sameEndpoint =
      previous?.kind === "openai_compatible" && previous.baseUrl === prepared.baseUrl;
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
    const visionModelIds = updateModelImageCapabilities(
      previousVisionModelIds,
      prepared.modelId,
      input.supportsImages,
    );
    const includeVisionModelIds =
      !options?.omitVisionModelIds &&
      (input.supportsImages !== undefined || previousVisionModelIds !== undefined);
    const secret: StoredModelSecret = {
      kind: "openai_compatible",
      baseUrl: prepared.baseUrl,
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
  const previous = tryParseModelSecret(previousPlaintext);
  const maxTokens = connectMaxTokens(input.maxTokens, previous?.maxTokens);
  if (apiKey) {
    if (apiKey.length < 8) throw new Error("API key must contain at least 8 characters");
    return serializeModelSecret({
      kind: "api_key",
      key: apiKey,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
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
    hasKey: true,
    isDefault: row.isDefault,
    ...(row.defaultModel ? { modelId: row.defaultModel } : {}),
    // Space-scoped effort stored beside the preference's modelId; the
    // openai-compatible secret may still contribute below when unset.
    ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel as ThinkingLevel } : {}),
  };
  if (row.provider !== CONTRACT_OPENAI_COMPAT) {
    if (!plaintext) return credential;
    const parsed = parseModelSecret(plaintext);
    return parsed.maxTokens !== undefined
      ? { ...credential, maxTokens: parsed.maxTokens }
      : credential;
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
    ...(parsed.maxImagesPerPrompt !== undefined
      ? { maxImagesPerPrompt: parsed.maxImagesPerPrompt }
      : {}),
    thinkingLevels: getSupportedThinkingLevels(
      openAiCompatibleModel(row.defaultModel ?? "custom", parsed.baseUrl, parsed.reasoning),
    ) as ThinkingLevel[],
    modelId: row.defaultModel ?? undefined,
  };
}
