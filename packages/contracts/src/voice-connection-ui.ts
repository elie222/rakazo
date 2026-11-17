import type { VoiceCatalogEntry, VoiceCredential } from "./domain.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./model-connections.js";

/**
 * What the voice settings form offers for a provider. Before it is connected, a provider whose
 * model connection can stand in for a key offers the account's connections to it
 * (`modelConnections`), or the Models sign-in when there are none (`modelSignIn`); the key form
 * then folds away. Once linked there is no key to show or replace (`linked`).
 */
export function voiceConnectionForm(input: {
  entry: Pick<VoiceCatalogEntry, "id" | "keyless" | "modelConnections" | "modelSignIn"> | undefined;
  credential: Pick<VoiceCredential, "hasKey"> | undefined;
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
  const modelConnections = input.credential ? [] : (input.entry?.modelConnections ?? []);
  return {
    linked: input.credential?.hasKey === false,
    canConnect,
    modelConnections,
    modelSignIn: input.credential || modelConnections.length ? undefined : input.entry?.modelSignIn,
  };
}
