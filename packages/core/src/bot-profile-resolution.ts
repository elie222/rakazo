import { BotRuntimeProfile, type BotRuntimeProfile as RuntimeProfile } from "@rakazo/contracts";

type ExistingBotSettings = {
  instructions: string;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  disabledBuiltinTools: string[];
};

export type BotRuntimeProfileInput = {
  settings?: RuntimeProfile | null;
  revision?: number | null;
};

export type EffectiveBotProfile = {
  persona: string;
  instructions: string;
  profile: RuntimeProfile;
  profileRevision: number | null;
  profileProvenance: "stored" | "defaults";
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  disabledBuiltinTools: string[];
};

/** Resolve profile data without changing legacy bot authority or instructions. */
export function resolveEffectiveBotProfile(
  bot: ExistingBotSettings,
  runtimeProfile?: BotRuntimeProfileInput | null,
): EffectiveBotProfile {
  const hasStoredProfile = runtimeProfile?.settings != null;
  const profile = hasStoredProfile
    ? BotRuntimeProfile.parse(runtimeProfile.settings)
    : BotRuntimeProfile.parse({});

  return {
    persona: profile.persona.persona,
    instructions: bot.instructions,
    profile,
    profileRevision: hasStoredProfile ? (runtimeProfile.revision ?? null) : null,
    profileProvenance: hasStoredProfile ? "stored" : "defaults",
    modelProvider: bot.modelProvider,
    modelId: bot.modelId,
    thinkingLevel: bot.thinkingLevel,
    disabledBuiltinTools: [...bot.disabledBuiltinTools],
  };
}
