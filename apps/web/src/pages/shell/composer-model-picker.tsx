import { useLingui } from "@lingui/react/macro";
import type { Bot, ThinkingLevel } from "@rakazo/contracts";
import type { ChatModelChoice } from "@rakazo/core";
import { botModelState, modelOptionKey, parseModelOptionKey } from "@rakazo/core";
import { Command, CommandGroup, CommandItem, CommandList, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { thinkingLevelLabel } from "../../lib/model-catalog";
import { useSave, useSpaceQueries } from "../../lib/query";
import { errorText } from "../../lib/user-error";
import { ChatModelPicker } from "./chat-model-picker";

/**
 * The chat's model beside Send, for people who turned it on. Its panel lists the models with the
 * thinking levels beside them; each pick saves to the bot.
 */
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
  const onFailed = (error: Error) => toast.error(errorText(error, t`Could not change the model`));
  const saveModel = useSave({
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
    stale: [queries.bots.list.key()],
    onSaved,
    onFailed,
  });
  const saveThinking = useSave({
    save: (level: ThinkingLevel | null, client) =>
      client.bots.update({ botId: bot.id, thinkingLevel: level }),
    stale: [queries.bots.list.key()],
    onSaved,
    onFailed,
  });

  if (!credentials || !catalog || !me) return null;
  const savedKey =
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "";
  const pendingModel = saveModel.pending ? saveModel.input : undefined;
  const modelPending = pendingModel !== undefined;
  const { selectedModelKey, defaultEntry, choices, thinkingLevels, defaultThinkingLevel } =
    botModelState({
      credentials,
      catalog,
      me,
      modelKey: pendingModel ?? savedKey,
      spaceDefaultLabel: t`Space default`,
    });
  // Nothing to switch between.
  if (choices.length < 2) return null;
  // A new model starts on its default level, so the saved one shows only while the model stays.
  const thinking: ThinkingLevel | null = modelPending
    ? null
    : saveThinking.pending
      ? (saveThinking.input ?? null)
      : bot.thinkingLevel;
  const shownThinking = thinkingLevels.length
    ? thinkingLevelLabel(thinking ?? defaultThinkingLevel)
    : undefined;
  const defaultLabel = thinkingLevelLabel(defaultThinkingLevel);
  const named = (choice: ChatModelChoice | undefined) => choice?.modelLabel ?? choice?.label;
  const shortLabel = selectedModelKey
    ? named(choices.find((choice) => choice.key === selectedModelKey))
    : (named(
        choices.find(
          (choice) =>
            choice.key !== "" &&
            choice.provider === me.defaultProvider &&
            choice.modelId === me.defaultModel,
        ),
      ) ??
      defaultEntry?.label ??
      me.defaultModel ??
      undefined);

  return (
    <ChatModelPicker
      compact
      choices={choices}
      value={selectedModelKey}
      // The button names the model alone (the one behind the Space default when the bot follows
      // it); the list keeps each row's full name.
      selectedLabel={shortLabel}
      detail={shownThinking}
      disabled={disabled || saveModel.pending || saveThinking.pending}
      onChange={(key) => {
        if (key !== selectedModelKey) saveModel.run(key);
      }}
      aside={
        thinkingLevels.length
          ? (close) => (
              <Command className="h-auto rounded-none bg-popover">
                <CommandList className="max-h-none">
                  <CommandGroup heading={t`Thinking`}>
                    {[null, ...thinkingLevels].map((level) => (
                      <CommandItem
                        key={level ?? "default"}
                        value={level ?? "default"}
                        data-checked={level === thinking}
                        onSelect={() => {
                          if (level !== thinking) saveThinking.run(level);
                          close();
                        }}
                      >
                        {level ? thinkingLevelLabel(level) : t`Default (${defaultLabel})`}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            )
          : undefined
      }
    />
  );
}
