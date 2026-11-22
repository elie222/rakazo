import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import { botModelPick, botModelState, modelOptionKey } from "@rakazo/core";
import { localizeModelEntry } from "@rakazo/i18n/model-provider";
import { thinkingLevelLabel } from "@rakazo/i18n/thinking-level";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Alert, View } from "react-native";
import { ModelPickerList } from "../components/models/model-picker-list";
import { SettingsGroup, SettingsRow } from "../components/settings/settings-group";
import { MenuPicker } from "../components/ui/menu-picker";
import { errorText } from "../lib/api/user-error";
import { chatModelPickerChoices } from "../lib/models/chat-model";
import { rpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

/** A chat's model and thinking, opened from the composer; each change saves at once. */
export default function ChatModelScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const botRead = rpcQuery("bots/get", { botId });
  const bot = useScreenQuery(botRead);
  const me = useScreenQuery(rpcQuery("me"));
  const catalog = useScreenQuery(rpcQuery("models/list"));
  const credentials = useScreenQuery(rpcQuery("models/credentials"));
  const save = useSave({
    // A model pick also resets thinking; a thinking pick sends only the level.
    save: (patch: { modelKey?: string; thinkingLevel: ThinkingLevel | null }, send) =>
      send("bots/update", {
        botId,
        ...(patch.modelKey === undefined
          ? { thinkingLevel: patch.thinkingLevel }
          : botModelPick(patch.modelKey)),
      }),
    // The chat's chip and the bot's settings read the bot again.
    stale: [botRead.queryKey],
    onFailed: (error) => Alert.alert(errorText(error, t`Could not change the model`)),
  });

  const ready = bot.data && me.data && catalog.data && credentials.data;
  const savedKey =
    bot.data?.modelProvider && bot.data.modelId
      ? modelOptionKey(bot.data.modelProvider, bot.data.modelId)
      : "";
  const pendingKey = save.pending ? save.input?.modelKey : undefined;
  const state = ready
    ? botModelState({
        credentials: credentials.data,
        catalog: catalog.data.map(localizeModelEntry),
        me: me.data,
        modelKey: pendingKey ?? savedKey,
        spaceDefaultLabel: t`Space default`,
      })
    : null;
  const choices =
    state && me.data && catalog.data && credentials.data
      ? chatModelPickerChoices(me.data, catalog.data, credentials.data, state.selectedModelKey)
      : null;
  const thinking = save.pending
    ? (save.input?.thinkingLevel ?? "")
    : (bot.data?.thinkingLevel ?? "");
  const failure = bot.error ?? me.error ?? catalog.error ?? credentials.error;
  // With no provider connected there is nothing to switch to, so the sheet offers a connection.
  const connectable = Boolean(state?.nothingConnected);

  return (
    <ModelPickerList
      choices={choices}
      selectedKey={state?.selectedModelKey ?? ""}
      error={failure && !choices ? errorText(failure, t`Could not load model settings`) : null}
      onSelect={(choice) => {
        if (!state || choice.key === state.selectedModelKey) return;
        // A new model starts on its own default thinking, as it does from the bot's settings.
        save.run({ modelKey: choice.key, thinkingLevel: null });
      }}
      header={
        state?.thinkingLevels.length || connectable ? (
          <View style={{ marginBottom: 20, gap: 20 }}>
            {state?.thinkingLevels.length ? (
              <SettingsGroup label={t`Thinking`}>
                <MenuPicker
                  label={t`Thinking`}
                  showLabel={false}
                  disabled={save.pending}
                  choices={[
                    {
                      key: "",
                      label: t`Default (${ph({ level: thinkingLevelLabel(state.defaultThinkingLevel) })})`,
                    },
                    ...state.thinkingLevels.map((level) => ({
                      key: level,
                      label: thinkingLevelLabel(level),
                    })),
                  ]}
                  value={thinking}
                  onChange={(level) =>
                    save.run({ thinkingLevel: (level || null) as ThinkingLevel | null })
                  }
                />
              </SettingsGroup>
            ) : null}
            {connectable ? (
              <SettingsGroup>
                <SettingsRow
                  accessibilityRole="button"
                  chevron="right"
                  onPress={() => router.push("/models")}
                  title={t`Connect a model`}
                />
              </SettingsGroup>
            ) : null}
          </View>
        ) : undefined
      }
    />
  );
}
