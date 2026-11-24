import { ConnectionSetupError } from "../integrations/connection-setup-error.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./model-connections.js";
import { normalizeOpenAiCompatibleBaseUrl } from "./openai-compatible-ui.js";
import type { VoiceCatalogEntry, VoiceCredential } from "./voice.js";

/**
 * What the voice settings form offers for a provider. Until connected, the account's model
 * connection can stand in for a key (`keyOptional`); once linked there is no key to show or
 * replace (`linked`).
 */
export function voiceConnectionForm(input: {
  entry: Pick<VoiceCatalogEntry, "id" | "keyless" | "modelConnection"> | undefined;
  credential: Pick<VoiceCredential, "hasKey"> | undefined;
  apiKey: string;
  baseUrl: string;
}): { keyOptional: boolean; linked: boolean; canConnect: boolean } {
  const keyOptional = Boolean(input.entry?.modelConnection) && !input.credential;
  const typedKey = input.apiKey.trim();
  const canConnect =
    Boolean(input.entry?.keyless) ||
    (input.entry?.id === OPENAI_COMPATIBLE_PROVIDER_ID
      ? Boolean(input.baseUrl.trim())
      : typedKey.length >= 8 || (keyOptional && !typedKey));
  return { keyOptional, linked: input.credential?.hasKey === false, canConnect };
}

/** The saved vocabulary belongs to the server that receives the recording. */
export function savedVoiceTranscriptionVocabulary(
  credential:
    | Pick<VoiceCredential, "endpoint" | "sttEndpoint" | "transcriptionVocabulary">
    | undefined,
  baseUrl: string,
  sttBaseUrl: string,
): string {
  if (!credential?.transcriptionVocabulary) return "";
  const savedEndpoint = credential.sttEndpoint || credential.endpoint;
  try {
    return normalizeOpenAiCompatibleBaseUrl(sttBaseUrl.trim() || baseUrl) === savedEndpoint
      ? credential.transcriptionVocabulary
      : "";
  } catch (error) {
    // The user may still be typing the address.
    if (error instanceof ConnectionSetupError) return "";
    throw error;
  }
}
