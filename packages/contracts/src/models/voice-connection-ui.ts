import { ConnectionSetupError } from "../integrations/connection-setup-error.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./model-connections.js";
import { normalizeOpenAiCompatibleBaseUrl } from "./openai-compatible-ui.js";
import type { VoiceCatalogEntry, VoiceCredential } from "./voice.js";

/**
 * What the voice settings form offers for a provider. Before it is connected, a provider whose
 * model connection can stand in for a key offers the account's connections to it
 * (`modelConnections`), or the Models sign-in when there are none (`modelSignIn`); the key form
 * then folds away. Once linked there is no key to show or replace (`linked`); the account's other
 * connections stay on offer to move to, and if the one it uses is gone, every choice comes back.
 */
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
  // A link that names no connection uses whichever the provider has, so only having none breaks it.
  const unlinked =
    input.credential?.hasKey === false &&
    (bound ? !choices.some((choice) => choice.id === bound) : choices.length === 0);
  const offers = !input.credential || unlinked;
  const linked = input.credential?.hasKey === false && !unlinked;
  // A working link can move to another of the account's connections; one that names none may be
  // on any of them, so it is offered all once there is more than one.
  const others = bound
    ? choices.filter((choice) => choice.id !== bound)
    : choices.length > 1
      ? choices
      : [];
  const modelConnections = offers ? choices : linked ? others : [];
  return {
    linked,
    canConnect,
    modelConnections,
    modelSignIn: offers && !choices.length ? input.entry?.modelSignIn : undefined,
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
