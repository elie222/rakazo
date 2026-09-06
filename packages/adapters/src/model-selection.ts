import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import {
  type findDefaultModelCredential,
  findModelCredential,
  type PrismaClient,
} from "@rakazo/db";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

export async function validateConnectedModelChoice(
  prisma: PrismaClient,
  actor: Actor,
  provider: string,
  modelId: string,
) {
  const credential = await findModelCredential(prisma, actor, provider);
  if (!credential) return "Connect that model provider first";
  const inCatalog = [...listPiCatalog(), scriptedCatalogEntry].some(
    (item) => item.provider === provider && item.id === modelId,
  );
  if (inCatalog) return undefined;
  const savedChoice = await prisma.spaceModelPreference.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      modelId,
      credential: { userId: actor.userId, provider },
    },
    select: { id: true },
  });
  return savedChoice ? undefined : "Unknown model for that provider";
}

/** Select configuration without loading secrets or applying a runtime-specific fallback. */
export function selectConfiguredModel(input: {
  bot: {
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: string | null;
  } | null;
  overrideCredential: ModelCredential;
  defaultCredential: ModelCredential;
  settings: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  deployment: { provider: string; model: string } | null;
}) {
  const { bot, overrideCredential, defaultCredential, settings, deployment } = input;
  const hasOverride = Boolean(bot?.modelProvider && bot.modelId);
  // The override provider, model and credential must win together.
  const useOverride = Boolean(hasOverride && overrideCredential);
  const credential = useOverride ? overrideCredential : defaultCredential;
  return {
    provider:
      (useOverride ? bot!.modelProvider : null) ??
      credential?.provider ??
      settings?.defaultModelProvider ??
      deployment?.provider,
    id:
      (useOverride ? bot!.modelId : null) ??
      credential?.defaultModel ??
      settings?.defaultModelId ??
      deployment?.model,
    credential,
    // Preserve bot thinking for the Space default; drop it for an unavailable override.
    thinkingLevel:
      hasOverride && !useOverride
        ? null
        : ((bot?.thinkingLevel as AgentRunRequest["model"]["thinkingLevel"]) ?? null),
  };
}
