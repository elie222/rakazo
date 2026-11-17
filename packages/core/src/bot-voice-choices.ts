import type { VoiceCatalogEntry, VoiceCredential, VoiceInfo } from "@rakazo/contracts";

/** Connected choices plus the saved provider, even when it has been disconnected. */
export function botVoiceProviderChoices(input: {
  provider?: string | null;
  credentials?: readonly Pick<VoiceCredential, "provider" | "voiceId" | "isDefault">[];
  catalog?: readonly Pick<VoiceCatalogEntry, "id" | "name">[];
}) {
  const name = (id: string) => input.catalog?.find((entry) => entry.id === id)?.name ?? id;
  const defaultConnection = input.credentials?.find((entry) => entry.isDefault);
  const connection = input.provider
    ? input.credentials?.find((entry) => entry.provider === input.provider)
    : defaultConnection;
  const options =
    input.credentials?.map((entry) => ({
      value: entry.provider,
      label: name(entry.provider),
    })) ?? [];
  if (input.provider && !options.some((entry) => entry.value === input.provider)) {
    options.push({ value: input.provider, label: name(input.provider) });
  }
  return {
    connection,
    options,
    defaultLabel: defaultConnection ? name(defaultConnection.provider) : undefined,
  };
}

/** Labels stay untranslated here; each platform owns its localized Default option. */
export function botVoiceChoices(input: {
  voices?: readonly VoiceInfo[];
  voiceId?: string | null;
  defaultVoiceId?: string;
}) {
  const options = input.voices?.map((voice) => ({ value: voice.id, label: voice.label })) ?? [];
  if (input.voiceId && !options.some((entry) => entry.value === input.voiceId)) {
    options.push({ value: input.voiceId, label: input.voiceId });
  }
  return {
    options,
    defaultLabel:
      input.voices?.find((voice) => voice.id === input.defaultVoiceId)?.label ||
      input.defaultVoiceId ||
      undefined,
  };
}

export type BotVoiceSelection = { voiceProvider?: string | null; voiceId?: string | null };

/** Pin custom voices to a provider; clearing a voice keeps that provider's Settings voice. */
export function botVoiceSelection(input: {
  provider?: string | null;
  currentProvider?: string | null;
  defaultProvider?: string | null;
  voiceId?: string | null;
}): BotVoiceSelection {
  const provider = input.provider !== undefined ? input.provider : (input.currentProvider ?? null);
  if (input.voiceId !== undefined) {
    return {
      voiceProvider: input.voiceId ? provider || input.defaultProvider || null : provider,
      voiceId: input.voiceId || null,
    };
  }
  if (input.provider !== undefined) {
    return {
      voiceProvider: provider,
      ...(provider !== (input.currentProvider ?? null) ? { voiceId: null } : {}),
    };
  }
  return {};
}
