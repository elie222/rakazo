/**
 * The composer's reasoning-effort control: the levels the current model offers,
 * and the bot's saved level. It reuses the connection form's rule: an
 * OpenAI-compatible endpoint takes its levels from the connection (reasoning
 * on, by wire protocol); any other model takes them from the catalog entry.
 * A model that cannot think offers nothing, so the button stays hidden.
 */

import type { ThinkingLevel } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleThinkingLevels,
  credentialForModel,
} from "@rakazo/core";
import { useEffect, useState } from "react";
import { rpc } from "./api";
import type { MobileBot, MobileModel, MobileModelCredential } from "./mobile-types";

/** The model a pick applies to: a just-saved model until the bot list catches up. */
export type ComposerModelRef = {
  provider: string | null;
  modelId: string | null;
};

export type ComposerThinkingLevel = {
  /** The effort levels the current model offers, in order. */
  levels: readonly ThinkingLevel[];
  /** The bot's saved level, clamped to what the model offers; "" is the default. */
  value: ThinkingLevel | "";
};

export type ComposerThinkingLevelControl = {
  state: ComposerThinkingLevel | null;
  save: (level: ThinkingLevel | "") => Promise<void>;
};

/**
 * The thinking levels the current model offers, or null when it cannot think.
 * The bot's saved level is clamped to what the model offers, so a previous
 * model's level never sticks.
 */
export function resolveComposerThinkingLevel(input: {
  bot: MobileBot | undefined;
  mainOverride: ComposerModelRef | null;
  catalog: readonly MobileModel[] | null;
  credentials: readonly MobileModelCredential[] | null;
}): ComposerThinkingLevel | null {
  const provider = input.mainOverride?.provider ?? input.bot?.modelProvider ?? null;
  const modelId = input.mainOverride?.modelId ?? input.bot?.modelId ?? null;
  if (!provider || !modelId) return null;
  const supported = supportedThinkingLevels(provider, modelId, input.catalog, input.credentials);
  if (!supported || supported.length === 0) return null;
  const clamped = clampCatalogThinkingLevel(input.bot?.thinkingLevel ?? null, supported);
  return { levels: supported, value: (clamped as ThinkingLevel | null) ?? "" };
}

function supportedThinkingLevels(
  provider: string,
  modelId: string,
  catalog: readonly MobileModel[] | null,
  credentials: readonly MobileModelCredential[] | null,
): readonly ThinkingLevel[] | undefined {
  if (provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const credential = credentials ? credentialForModel(credentials, provider, modelId) : undefined;
    return credential?.reasoning ? compatibleThinkingLevels(credential.apiProtocol) : [];
  }
  return catalog?.find((entry) => entry.provider === provider && entry.id === modelId)
    ?.thinkingLevels;
}

/** Saves the bot's thinking level; "" restores the default. */
export async function saveComposerThinkingLevel(
  botId: string,
  level: ThinkingLevel | "",
): Promise<void> {
  await rpc("bots/update", { botId, thinkingLevel: level === "" ? null : level });
}

export function useComposerThinkingLevel(input: {
  botId: string | undefined;
  bot: MobileBot | undefined;
  mainOverride: ComposerModelRef | null;
  catalog: readonly MobileModel[] | null;
  credentials: readonly MobileModelCredential[] | null;
}): ComposerThinkingLevelControl {
  const resolved = resolveComposerThinkingLevel(input);
  // The level saved from the menu, until the chat's bot list catches up with it.
  const [override, setOverride] = useState<ThinkingLevel | "" | null>(null);
  useEffect(() => {
    setOverride(null);
  }, [input.bot?.thinkingLevel]);

  const state = resolved && override !== null ? { ...resolved, value: override } : resolved;

  async function save(level: ThinkingLevel | "") {
    if (!input.botId || !resolved || level === resolved.value) return;
    setOverride(level);
    try {
      await saveComposerThinkingLevel(input.botId, level);
    } catch {
      // The menu closes on pick; a failed save puts the checkmark back.
      setOverride(resolved.value);
    }
  }

  return { state, save };
}
