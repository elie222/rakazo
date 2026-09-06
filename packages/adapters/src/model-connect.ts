import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelConnectInput, ModelCredential, ThinkingLevel } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID as CONTRACT_OPENAI_COMPAT } from "@rakazo/contracts";
import { parseModelSecret, type StoredModelSecret, serializeModelSecret } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleModel,
  prepareOpenAiCompatibleConnect,
} from "./pi-openai-compatible-provider.js";

export function buildModelConnectPlaintext(
  input: ModelConnectInput,
  previousPlaintext?: string,
): string {
  if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const prepared = prepareOpenAiCompatibleConnect(input);
    const previous = previousPlaintext ? parseModelSecret(previousPlaintext) : undefined;
    if (
      input.apiKey === undefined &&
      previous?.kind === "openai_compatible" &&
      previous.baseUrl === prepared.baseUrl
    ) {
      // Revalidate the inherited key too: public endpoints must still use HTTPS.
      prepared.apiKey = prepareOpenAiCompatibleConnect({
        ...input,
        apiKey: previous.apiKey,
      }).apiKey;
    }
    const secret: StoredModelSecret = {
      kind: "openai_compatible",
      baseUrl: prepared.baseUrl,
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(prepared.apiKey ? { apiKey: prepared.apiKey } : {}),
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
  if (row.provider !== CONTRACT_OPENAI_COMPAT || !plaintext) return credential;
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind !== "openai_compatible") return credential;
  return {
    ...credential,
    baseUrl: parsed.baseUrl,
    reasoning: parsed.reasoning ?? false,
    thinkingLevels: getSupportedThinkingLevels(
      openAiCompatibleModel(row.defaultModel ?? "custom", parsed.baseUrl, parsed.reasoning),
    ) as ThinkingLevel[],
    modelId: row.defaultModel ?? undefined,
  };
}
