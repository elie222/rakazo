import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { modelOptionKey, parseModelOptionKey } from "@rakazo/core";
import { toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { botModelChoices } from "../../lib/bot-model-choices";
import { useSave, useSpaceQueries } from "../../lib/query";
import { errorText } from "../../lib/user-error";
import { ChatModelPicker } from "./chat-model-picker";

/** The chat's model beside Send, for people who turned it on; a pick saves to the bot. */
export function ComposerModelPicker({
  bot,
  disabled,
  onSaved,
}: {
  bot: Bot;
  disabled?: boolean;
  onSaved: (bot: Bot) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const credentials = useQuery(queries.models.credentials.queryOptions()).data;
  const catalog = useQuery(queries.models.list.queryOptions()).data;
  const me = useQuery(queries.me.queryOptions()).data;
  const save = useSave({
    // A new model starts on its own default thinking level, as it does from the bot's settings.
    save: (key: string, client) => {
      const model = key ? parseModelOptionKey(key) : null;
      return client.bots.update({
        botId: bot.id,
        modelProvider: model?.provider ?? null,
        modelId: model?.modelId ?? null,
        thinkingLevel: null,
      });
    },
    onSaved,
    onFailed: (error) => toast.error(errorText(error, t`Could not change the model`)),
  });

  if (!credentials || !catalog || !me) return null;
  const savedKey =
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "";
  const { selectedModelKey, defaultEntry, choices } = botModelChoices({
    credentials,
    catalog,
    me,
    modelKey: save.pending ? (save.input ?? savedKey) : savedKey,
    spaceDefaultLabel: t`Space default`,
  });
  // Nothing to switch between.
  if (choices.length < 2) return null;
  // The button names the model the Space default stands for; the list still says "Space default".
  if (me.defaultModel)
    choices[0] = {
      ...choices[0]!,
      label: defaultEntry?.label ?? me.defaultModel,
      title: t`Space default`,
    };

  return (
    <ChatModelPicker
      compact
      choices={choices}
      value={selectedModelKey}
      disabled={disabled || save.pending}
      onChange={(key) => {
        if (key !== savedKey) save.run(key);
      }}
    />
  );
}
