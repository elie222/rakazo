import { ConnectionSetupError } from "../integrations/connection-setup-error.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./model-connections.js";
import { normalizeOpenAiCompatibleBaseUrl } from "./openai-compatible-ui.js";
import type { VoiceCatalogEntry, VoiceCredential } from "./voice.js";

/** Offers a Models connection or sign-in and omits the connection that already serves voice. */
export function voiceConnectionForm(input: {
  entry: Pick<VoiceCatalogEntry, "id" | "keyless" | "modelConnections" | "modelSignIn"> | undefined;
  credential: Pick<VoiceCredential, "hasKey" | "modelCredentialId"> | undefined;
  apiKey: string;
  baseUrl: string;
}): {
  linked: boolean;
  /** The key form can be sent. */
  canConnect: boolean;
  modelConnections: { id: string; label: string }[];
  modelSignIn: string | undefined;
} {
  const typedKey = input.apiKey.trim();
  const canConnect =
    Boolean(input.entry?.keyless) ||
    (input.entry?.id === OPENAI_COMPATIBLE_PROVIDER_ID
      ? Boolean(input.baseUrl.trim())
      : typedKey.length >= 8);
  const choices = input.entry?.modelConnections ?? [];
  const bound = input.credential?.modelCredentialId;
  const linked =
    input.credential?.hasKey === false &&
    (bound ? choices.some((choice) => choice.id === bound) : choices.length > 0);
  let modelConnections = choices;
  if (linked && bound) modelConnections = choices.filter((choice) => choice.id !== bound);
  // A legacy link uses the preferred connection, so offer explicit choices if there are several.
  if (linked && !bound && choices.length === 1) modelConnections = [];
  return {
    linked,
    canConnect,
    modelConnections,
    modelSignIn: choices.length ? undefined : input.entry?.modelSignIn,
  };
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
