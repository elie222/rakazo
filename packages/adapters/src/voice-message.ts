import type { AdapterContext, SpeechClip } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultVoiceCredential } from "@rakazo/db";
import { isVoiceProviderId } from "./voice-factory.js";
import type { DefaultVoiceDeps } from "./voice-model-connection.js";
import { loadDefaultVoice } from "./voice-model-connection.js";

type VoiceScope = { userId: string; spaceId: string };

/** The bot's own voice, else the one the person chose for their default connection here. */
function chosenVoice(botVoiceId: string | null | undefined, connectionVoiceId: string) {
  return botVoiceId || connectionVoiceId;
}

/** Whether the person has a voice to speak with here: a usable default connection and a voice. */
export async function hasVoiceForMessages(
  prisma: PrismaClient,
  scope: VoiceScope,
  botVoiceId: string | null | undefined,
): Promise<boolean> {
  const credential = await findDefaultVoiceCredential(prisma, scope);
  return Boolean(
    credential &&
      isVoiceProviderId(credential.provider) &&
      chosenVoice(botVoiceId, credential.voiceId),
  );
}

/**
 * Speaks `text` with the person's default voice connection here, in the bot's voice when it has
 * one. Null when they have no connection or no voice chosen.
 */
export async function speakVoiceMessage(
  deps: DefaultVoiceDeps,
  scope: VoiceScope,
  input: { text: string; botVoiceId: string | null | undefined },
  context: AdapterContext,
): Promise<SpeechClip | null> {
  const voice = await loadDefaultVoice(deps, scope, context.signal);
  if (!voice) return null;
  const voiceId = chosenVoice(input.botVoiceId, voice.credential.voiceId);
  if (!voiceId) return null;
  return voice.provider.synthesize(
    {
      text: input.text,
      voiceId,
      apiKey: voice.apiKey,
      model: voice.credential.speechModel || undefined,
      signal: context.signal,
    },
    context,
  );
}
