import { t } from "@lingui/core/macro";
import type { ModelMark } from "@rakazo/core";
import { botModelState, modelOptionKey } from "@rakazo/core";
import { localizeModelEntry } from "@rakazo/i18n/model-provider";
import { thinkingLevelLabel } from "@rakazo/i18n/thinking-level";
import { useRouter } from "expo-router";
import { useSyncExternalStore } from "react";
import type { MobileMe, MobileModel, MobileModelCredential } from "../api/mobile-types";
import { rpcQuery } from "../query/query";
import { useScreenQuery } from "../query/screen-query";
import {
  getCachedComposerModelPicker,
  subscribeComposerModelPicker,
} from "./composer-model-picker-preference";

export type ComposerModel = {
  label: string;
  /** The maker's mark; a generic chip shows without one. */
  mark?: ModelMark;
  thinking?: string;
  onPress: () => void;
};

type BotModel = {
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
};

/** The chip a bot chat's composer shows when the person turned the model picker on. */
export function useComposerModel(
  botId: string | undefined,
  me: MobileMe | undefined,
): ComposerModel | undefined {
  const router = useRouter();
  const deviceModelPicker = useSyncExternalStore(
    subscribeComposerModelPicker,
    getCachedComposerModelPicker,
    () => false,
  );
  const on = me?.chatPreferences?.composerModelPicker ?? deviceModelPicker;
  const enabled = on && Boolean(botId);
  const read = { enabled };
  const bot = useScreenQuery(rpcQuery("bots/get", { botId: botId ?? "" }), read).data;
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
): Omit<ComposerModel, "onPress"> | null {
  const modelKey =
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "";
  const state = botModelState({
    credentials,
    catalog: catalog.map(localizeModelEntry),
    me,
    modelKey,
    spaceDefaultLabel: t`Space default`,
  });
  const level = (bot.thinkingLevel as typeof state.defaultThinkingLevel | null | undefined) ?? null;
  return {
    label: state.selectedName ?? t`Space default`,
    mark: state.selectedMark,
    thinking: state.thinkingLevels.length
      ? thinkingLevelLabel(level ?? state.defaultThinkingLevel)
      : undefined,
  };
}
