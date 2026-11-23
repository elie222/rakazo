import { ORPCError } from "@orpc/server";
import { knownVoiceProvider } from "@rakazo/adapters";
import type { Actor, RealtimeCallSettings, RealtimeCallState } from "@rakazo/contracts";
import { parseRealtimeCallSettings } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { newestVoiceCredentialOrder } from "@rakazo/db";

type Prisma = Pick<PrismaClient, "user" | "userVoiceCredential">;

/** Connected voice providers that can hold a realtime call, newest connection first. */
async function realtimeProviders(prisma: Prisma, userId: string) {
  const rows = await prisma.userVoiceCredential.findMany({
    where: { userId },
    select: { provider: true },
    orderBy: newestVoiceCredentialOrder,
  });
  const providers = [...new Set(rows.map((row) => row.provider))];
  return providers.flatMap((provider) => {
    const realtime = knownVoiceProvider(provider)?.realtime;
    return realtime
      ? [{ provider, models: [...realtime.models], voices: [...realtime.voices] }]
      : [];
  });
}

export async function realtimeCallState(
  prisma: Prisma,
  actor: Pick<Actor, "userId">,
  enabled: boolean,
): Promise<RealtimeCallState> {
  const [user, providers] = await Promise.all([
    prisma.user.findUnique({ where: { id: actor.userId }, select: { realtimeCall: true } }),
    enabled ? realtimeProviders(prisma, actor.userId) : [],
  ]);
  return {
    available: providers.length > 0,
    settings: parseRealtimeCallSettings(user?.realtimeCall),
    providers,
  };
}

export async function saveRealtimeCallSettings(
  prisma: Prisma,
  actor: Pick<Actor, "userId">,
  enabled: boolean,
  input: RealtimeCallSettings,
): Promise<RealtimeCallState> {
  const state = await realtimeCallState(prisma, actor, enabled);
  const settings = { ...input };
  if (settings.model) {
    const entry = state.providers.find((candidate) => candidate.provider === settings.provider);
    if (!entry?.models.some((model) => model.id === settings.model)) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Connect a voice provider that offers this realtime model first.",
      });
    }
    if (settings.voiceId && !entry.voices.includes(settings.voiceId)) {
      throw new ORPCError("BAD_REQUEST", { message: "This voice is not available for calls." });
    }
  }
  // JSON drops the settings that were never chosen, so the provider defaults stay in charge.
  const stored = JSON.parse(JSON.stringify(settings));
  await prisma.user.update({ where: { id: actor.userId }, data: { realtimeCall: stored } });
  return { ...state, settings: parseRealtimeCallSettings(stored) };
}
