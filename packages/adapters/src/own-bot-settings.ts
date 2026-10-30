import type { Actor } from "@rakazo/contracts";
import { ThinkingLevelSchema } from "@rakazo/contracts";
import type { FleetPrepareDeps } from "./fleet-tools.js";
import { modelLabel } from "./fleet-tools.js";
import { connectedModelChoices, resolveModelChoice } from "./model-choice.js";
import { prepareAllowedThinkingLevels, validateBotModelChange } from "./model-selection.js";

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
};

export type OwnBotSettingsData = {
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  autoSpeak?: boolean;
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
    models: [...providers].map(([provider, ids]) => ({
      provider,
      ids: ids.slice(0, MODELS_PER_PROVIDER),
      ...(ids.length > MODELS_PER_PROVIDER ? { more: ids.length - MODELS_PER_PROVIDER } : {}),
    })),
    thinkingLevels: levels?.allowed ?? ThinkingLevelSchema.options,
  };
}

/** The model, thinking and read-aloud fields of `update_bot`, checked like the settings screen. */
export async function prepareOwnBotSettings(
  deps: FleetPrepareDeps,
  scope: Pick<Actor, "userId" | "spaceId">,
  bot: Pick<OwnBotSettingsRow, "modelProvider" | "modelId" | "thinkingLevel">,
  args: { model?: unknown; thinkingLevel?: unknown; readAloud?: unknown },
): Promise<{ data: OwnBotSettingsData } | { error: string }> {
  const data: OwnBotSettingsData = {};
  if (args.readAloud !== undefined) {
    if (typeof args.readAloud !== "boolean") return { error: "readAloud must be true or false." };
    data.autoSpeak = args.readAloud;
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
  data.thinkingLevel = validated.thinkingLevel;
  return { data };
}
