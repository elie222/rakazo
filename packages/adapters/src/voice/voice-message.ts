import type { AdapterContext, SpeechClip } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultVoiceCredential } from "@rakazo/db";
import { isVoiceProviderId } from "./voice-factory.js";
import type { DefaultVoiceDeps } from "./voice-model-connection.js";
import { loadDefaultVoice, withVoiceConnection } from "./voice-model-connection.js";

type VoiceScope = { userId: string; spaceId: string };

/**
 * Speaking spends the person's own voice provider without an approval card, so only their own
 * words may ask for it: their app chat or call, or their own messaging-app chat. Never another
 * bot, a routine, a webhook, or someone else in a shared chat.
 */
export function voiceMessageRequestedByOwner(
  trigger: string,
  source: { ownerStartedRun: boolean; messagingChannelRun: boolean },
): boolean {
  if (source.messagingChannelRun) return false;
  return source.ownerStartedRun || trigger === "messaging";
}

/** The bot's own voice, else the one the person chose for their default connection here. */
function chosenVoice(botVoiceId: string | null | undefined, connectionVoiceId: string) {
  return botVoiceId || connectionVoiceId;
}

/** Whether the person can speak here: a usable default connection with its key, and a voice. */
export async function hasVoiceForMessages(
  prisma: PrismaClient,
  scope: VoiceScope,
  botVoiceId: string | null | undefined,
): Promise<boolean> {
  const credential = await findDefaultVoiceCredential(prisma, scope);
  if (
    !credential ||
    !isVoiceProviderId(credential.provider) ||
    !chosenVoice(botVoiceId, credential.voiceId)
  )
    return false;
  const keys = await prisma.secret.count({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
  });
  return keys > 0;
}

/**
 * Speaks `text` with the person's default voice connection here, in the bot's voice when it has
 * one. Otherwise says what is missing: the connection (or its key), or a chosen voice.
 */
export async function speakVoiceMessage(
  deps: DefaultVoiceDeps,
  scope: VoiceScope,
  input: { text: string; botVoiceId: string | null | undefined },
  context: AdapterContext,
): Promise<{ clip: SpeechClip; provider: string } | { missing: "connection" | "voice" }> {
  const voice = await loadDefaultVoice(deps, scope, context.signal);
  if (!voice) return { missing: "connection" };
  const voiceId = chosenVoice(input.botVoiceId, voice.credential.voiceId);
  if (!voiceId) return { missing: "voice" };
  const clip = await withVoiceConnection(voice.credential.provider, voice.linked, () =>
    voice.provider.synthesize(
      {
        text: input.text,
        voiceId,
        apiKey: voice.apiKey,
        model: voice.credential.speechModel || undefined,
        signal: context.signal,
      },
      context,
    ),
  );
  return { clip, provider: voice.credential.provider };
}
