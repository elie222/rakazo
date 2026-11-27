import { createHash } from "node:crypto";
import type { AdapterContext, SpeechClip } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { attachmentExtensionForMimeType } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultVoiceCredential } from "@rakazo/db";
import { isVoiceProviderId } from "./voice-factory.js";
import type { DefaultVoiceDeps } from "./voice-model-connection.js";
import { loadDefaultVoice, voiceOutage, withVoiceConnection } from "./voice-model-connection.js";

type VoiceScope = { userId: string; spaceId: string };

/**
 * Speaking spends the person's own voice provider without an approval card, so only their own
 * words may ask for it: their app chat or call, or their own messaging-app chat. Never another
 * bot, a routine, a webhook, or someone else in a shared chat. Hanging up a call starts a run with
 * no new words from them, and its reply is written.
 */
export function voiceMessageRequestedByOwner(
  trigger: string,
  source: { ownerStartedRun: boolean; messagingChannelRun: boolean },
): boolean {
  if (source.messagingChannelRun || trigger === "call_end") return false;
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
 *
 * A bot's voice is saved without the provider it came from, so after the person switches provider
 * it can name a voice the new one lacks. When the provider refuses it for anything but the
 * account or an outage, the connection's own voice is tried once.
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
  const speak = (inVoice: string) =>
    voice.provider.synthesize(
      {
        text: input.text,
        voiceId: inVoice,
        apiKey: voice.apiKey,
        model: voice.credential.speechModel || undefined,
        signal: context.signal,
      },
      context,
    );
  const fallback = voice.credential.voiceId;
  const clip = await withVoiceConnection(voice.credential.provider, voice.linked, async () => {
    try {
      return await speak(voiceId);
    } catch (error) {
      if (
        !fallback ||
        fallback === voiceId ||
        error instanceof VoiceAccountError ||
        voiceOutage(error) ||
        context.signal.aborted
      )
        throw error;
      return speak(fallback);
    }
  });
  return { clip, provider: voice.credential.provider };
}

/**
 * A recording's file name: its own per call, so two recordings are two files rather than versions
 * of one, and the same for a retried attempt of that call.
 */
export function voiceMessageFileName(callId: string, mimeType: string): string {
  const id = createHash("sha256").update(callId).digest("hex").slice(0, 8);
  return `voice-message-${id}${attachmentExtensionForMimeType(mimeType) || ".mp3"}`;
}
