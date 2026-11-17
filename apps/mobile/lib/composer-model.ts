import { t } from "@lingui/core/macro";
import { botModelState, modelOptionKey } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useSyncExternalStore } from "react";
import {
  getCachedComposerModelPicker,
  subscribeComposerModelPicker,
} from "./composer-model-picker-preference";
import type { MobileMe, MobileModel, MobileModelCredential } from "./mobile-types";
import { rpcQuery } from "./query";
import { useScreenQuery } from "./screen-query";
import { thinkingLevelLabel } from "./thinking-level";

export type ComposerModel = { label: string; thinking?: string; onPress: () => void };

type BotModel = {
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
};

/** The chip a bot chat's composer shows when the person turned the model picker on. */
export function useComposerModel(botId: string | undefined): ComposerModel | undefined {
  const router = useRouter();
  const on = useSyncExternalStore(
    subscribeComposerModelPicker,
    getCachedComposerModelPicker,
    () => false,
  );
  const enabled = on && Boolean(botId);
  const read = { enabled, onForeground: false };
  const bot = useScreenQuery(rpcQuery("bots/get", { botId: botId ?? "" }), read).data;
  const me = useScreenQuery(rpcQuery("me"), read).data;
  const catalog = useScreenQuery(rpcQuery("models/list"), read).data;
  const credentials = useScreenQuery(rpcQuery("models/credentials"), read).data;
  if (!enabled || !botId || !bot || !me || !catalog || !credentials) return undefined;
  const chip = composerModelChip(bot, me, catalog, credentials);
  if (!chip) return undefined;
  return {
    ...chip,
    onPress: () => router.push({ pathname: "/chat-model", params: { botId } }),
  };
}

/** What the chip says: the model's own name (the Space default's, when the bot follows it) and its thinking. */
export function composerModelChip(
  bot: BotModel,
  me: MobileMe,
  catalog: MobileModel[],
  credentials: MobileModelCredential[],
): { label: string; thinking?: string } | null {
  const modelKey =
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "";
  const state = botModelState({
    credentials,
    catalog,
    me,
    modelKey,
    spaceDefaultLabel: t`Space default`,
  });
  // Nothing to switch between.
  if (state.choices.length < 2) return null;
  const level = (bot.thinkingLevel as typeof state.defaultThinkingLevel | null | undefined) ?? null;
  return {
    label: state.selectedName ?? t`Space default`,
    thinking: state.thinkingLevels.length
      ? thinkingLevelLabel(level ?? state.defaultThinkingLevel)
      : undefined,
  };
}
