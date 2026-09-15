import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelConnectInput, ModelCredential, ThinkingLevel } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID as CONTRACT_OPENAI_COMPAT } from "@rakazo/contracts";
import { modelIdSupportsImages, updateModelImageCapabilities } from "./model-vision.js";
import { parseModelSecret, type StoredModelSecret, serializeModelSecret } from "./pi-oauth.js";
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
    const previous = previousPlaintext ? parseModelSecret(previousPlaintext) : undefined;
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
    const maxTokens =
      input.maxTokens !== undefined
        ? input.maxTokens
        : sameEndpoint
          ? previous.maxTokens
          : undefined;
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
  if (!apiKey || apiKey.length < 8) {
    throw new Error("API key must contain at least 8 characters");
  }
  return apiKey;
}

export function modelCredentialDto(
  row: {
    id: string;
    provider: string;
    label: string;
    isDefault: boolean;
    defaultModel?: string | null;
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
  };
  if (row.provider !== CONTRACT_OPENAI_COMPAT) return credential;
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
    ...(parsed.thinkingLevel !== undefined ? { thinkingLevel: parsed.thinkingLevel } : {}),
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
