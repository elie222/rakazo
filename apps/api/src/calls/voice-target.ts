import type { Actor, SettingsScope } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultVoiceCredential, findVoiceCredential, IsolationError } from "@rakazo/db";

async function botVoiceSettings(
  deps: { prisma: PrismaClient },
  actor: Pick<Actor, "userId" | "spaceId">,
  botId?: string,
) {
  if (!botId) return null;
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId },
    select: { voiceProvider: true, voiceId: true },
  });
  if (!bot) throw new IsolationError();
  return bot;
}

/** Shared speech selection for disclosure, status and playback; never opens secrets. */
export async function selectVoiceTarget(
  deps: { prisma: PrismaClient },
  actor: Pick<Actor, "userId" | "spaceId">,
  input: { botId?: string; provider?: string; voiceId?: string; scope?: SettingsScope } = {},
) {
  const bot = await botVoiceSettings(deps, actor, input.botId);
  const provider = input.provider ?? bot?.voiceProvider ?? undefined;
  const cred = provider
    ? await findVoiceCredential(deps.prisma, actor, provider, input.scope)
    : await findDefaultVoiceCredential(deps.prisma, actor, input.scope);
  // An explicit provider previews an unsaved choice, not the saved bot voice.
  const voiceId =
    input.voiceId || (input.provider === undefined && bot?.voiceId) || cred?.voiceId || "";
  return { cred, voiceId, usesDefault: !provider };
}
