import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./model-connections.js";
import type { VoiceCatalogEntry, VoiceCredential } from "./voice.js";

/**
 * What the voice settings form offers for a provider. Before it is connected, a provider whose
 * model connection can stand in for a key offers the account's connections to it
 * (`modelConnections`), or the Models sign-in when there are none (`modelSignIn`); the key form
 * then folds away. Once linked there is no key to show or replace (`linked`), unless the model
 * connection it uses is gone: then the choices come back so it can be linked again.
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
  const modelConnections = offers ? choices : [];
  return {
    linked: input.credential?.hasKey === false && !unlinked,
    canConnect,
    modelConnections,
    modelSignIn: offers && !choices.length ? input.entry?.modelSignIn : undefined,
  };
}
