import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import type { Actor, BotSettingsValues, VoiceInfo } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultVoiceCredential } from "@rakazo/db";
import type { FleetPrepareDeps } from "./fleet-tools.js";
import { modelLabel } from "./fleet-tools.js";
import { connectedModelChoices, resolveModelChoice, words } from "./model-choice.js";
import { prepareAllowedThinkingLevels, validateBotModelChange } from "./model-selection.js";
import { OPENAI_COMPATIBLE_VOICE_PROVIDER_ID } from "./openai-compatible-voice.js";
import { createVoiceProvider } from "./voice-factory.js";

export type OwnBotSettingsRow = {
  name: string;
  description: string;
  instructions: string;
  color: string;
  notifyOnFinish: boolean;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  autoSpeak: boolean;
  voiceId: string | null;
};

/** Ids listed per connected provider; the rest are reachable by name. */
const MODELS_PER_PROVIDER = 15;

/** `update_bot` with no fields: this bot's settings and the values it may set. */
export async function readOwnBotSettings(
  deps: FleetPrepareDeps,
  scope: Pick<Actor, "userId" | "spaceId">,
  bot: OwnBotSettingsRow,
) {
  const modelDeps = { prisma: deps.prisma, ...deps.modelChange };
  const effective =
    bot.modelProvider && bot.modelId
      ? { provider: bot.modelProvider, model: bot.modelId }
      : await deps.modelChange.defaultModel();
  const [choices, levels] = await Promise.all([
    connectedModelChoices(modelDeps, scope),
    effective.provider && effective.model
      ? prepareAllowedThinkingLevels(modelDeps, scope, effective.provider, effective.model)
      : undefined,
  ]);
  const providers = new Map<string, string[]>();
  for (const choice of choices) {
    const ids = providers.get(choice.providerName) ?? [];
    ids.push(`${choice.provider}/${choice.id}`);
    providers.set(choice.providerName, ids);
  }
  return {
    name: bot.name,
    description: bot.description,
    instructions: bot.instructions,
    avatar: bot.color.startsWith("data:image/") ? "image" : bot.color,
    notifyOnFinish: bot.notifyOnFinish,
    model: `${modelLabel(effective.provider, effective.model)}${bot.modelId ? "" : " (default)"}`,
    thinkingLevel: bot.thinkingLevel ?? "default",
    readAloud: bot.autoSpeak,
    voice: bot.voiceId ?? "default",
    models: [...providers].map(([provider, ids]) => ({
      provider,
      ids: ids.slice(0, MODELS_PER_PROVIDER),
      ...(ids.length > MODELS_PER_PROVIDER ? { more: ids.length - MODELS_PER_PROVIDER } : {}),
    })),
    thinkingLevels: levels?.allowed ?? ThinkingLevelSchema.options,
  };
}

/** The voices the settings screen offers: those of the user's default voice connection here. */
export async function listDefaultVoices(
  deps: {
    prisma: PrismaClient;
    secretStore: Pick<SecretStore, "load">;
    mcpAllowPrivateEndpoint?: boolean;
  },
  scope: Pick<Actor, "userId" | "spaceId">,
  context: AdapterContext,
): Promise<VoiceInfo[] | null> {
  const credential = await findDefaultVoiceCredential(deps.prisma, scope);
  const secret =
    credential &&
    (await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    }));
  if (!credential || !secret) return null;
  const provider = createVoiceProvider(credential.provider, {
    allowPrivateEndpoint:
      credential.provider === OPENAI_COMPATIBLE_VOICE_PROVIDER_ID &&
      deps.mcpAllowPrivateEndpoint === true,
  });
  return provider.listVoices(await deps.secretStore.load(secret.ciphertext, secret.id), context);
}

const VOICES_SHOWN = 10;

/** A voice by id or name as people say it; "default" follows the account's voice. */
export function resolveVoiceChoice(
  voices: readonly VoiceInfo[],
  query: string,
): { ok: true; voiceId: string | null } | { ok: false; error: string } {
  const wanted = query.trim().toLowerCase();
  if (wanted === "default") return { ok: true, voiceId: null };
  const exact = voices.filter(
    (voice) => voice.id.toLowerCase() === wanted || voice.label.toLowerCase() === wanted,
  );
  const asked = words(query);
  const matches = exact.length
    ? exact
    : voices.filter((voice) => {
        const have = new Set(words(voice.label));
        return asked.length > 0 && asked.every((word) => have.has(word));
      });
  const [match] = matches;
  if (match && matches.length === 1) return { ok: true, voiceId: match.id };
  const named = (list: readonly VoiceInfo[]) =>
    list
      .slice(0, VOICES_SHOWN)
      .map((voice) => voice.label)
      .join(", ");
  return {
    ok: false,
    error: matches.length
      ? `"${query}" matches several voices. Ask the user which one: ${named(matches)}.`
      : `No voice matches "${query}". Voices: ${named(voices)}.`,
  };
}

/** The model, thinking, voice and read-aloud fields of `update_bot`, checked like the settings screen. */
export async function prepareOwnBotSettings(
  deps: FleetPrepareDeps,
  scope: Pick<Actor, "userId" | "spaceId">,
  bot: Pick<OwnBotSettingsRow, "modelProvider" | "modelId" | "thinkingLevel">,
  args: { model?: unknown; thinkingLevel?: unknown; readAloud?: unknown; voice?: unknown },
  listVoices: () => Promise<VoiceInfo[] | null> = async () => null,
): Promise<{ data: BotSettingsValues } | { error: string }> {
  const data: BotSettingsValues = {};
  if (args.readAloud !== undefined) {
    if (typeof args.readAloud !== "boolean") return { error: "readAloud must be true or false." };
    data.autoSpeak = args.readAloud;
  }
  if (typeof args.voice === "string" && args.voice.trim()) {
    let voices: VoiceInfo[] | null;
    try {
      voices = args.voice.trim().toLowerCase() === "default" ? [] : await listVoices();
    } catch (error) {
      if (error instanceof VoiceAccountError) return { error: error.message };
      return { error: "Could not list voices right now; try again." };
    }
    if (!voices) return { error: "Connect a voice provider first." };
    const voice = resolveVoiceChoice(voices, args.voice);
    if (!voice.ok) return { error: voice.error };
    data.voiceId = voice.voiceId;
  }
  const model = typeof args.model === "string" ? args.model.trim() : "";
  const level = typeof args.thinkingLevel === "string" ? args.thinkingLevel.trim() : "";
  if (!model && !level) return { data };
  // A model without catalog levels skips the shared check, so the level must be a real one first.
  if (level && !ThinkingLevelSchema.safeParse(level).success)
    return { error: `thinkingLevel must be one of: ${ThinkingLevelSchema.options.join(", ")}` };
  const modelDeps = { prisma: deps.prisma, ...deps.modelChange };
  let provider = bot.modelProvider;
  let modelId = bot.modelId;
  if (model) {
    const chosen = await resolveModelChoice(modelDeps, scope, {
      model,
      preferredProvider: bot.modelProvider ?? (await deps.modelChange.defaultModel()).provider,
    });
    if (!chosen.ok) return { error: chosen.error };
    provider = chosen.provider;
    modelId = chosen.model;
  }
  const validate = (thinkingLevel: string | null) =>
    validateBotModelChange(modelDeps, {
      ...scope,
      provider,
      model: modelId,
      thinkingLevel,
      current: { provider: bot.modelProvider, model: bot.modelId },
    });
  let validated = await validate(level || bot.thinkingLevel);
  // A new model keeps the current thinking level when it supports it, else uses its default.
  if (!validated.ok && !level && bot.thinkingLevel) validated = await validate(null);
  if (!validated.ok) return { error: validated.error };
  if (model) {
    data.modelProvider = validated.provider;
    data.modelId = validated.model;
  }
  data.thinkingLevel = ThinkingLevelSchema.nullable().parse(validated.thinkingLevel);
  return { data };
}
