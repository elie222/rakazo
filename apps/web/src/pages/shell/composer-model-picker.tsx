import { useLingui } from "@lingui/react/macro";
import type { Bot, ThinkingLevel } from "@rakazo/contracts";
import { botModelPick, botModelState, modelOptionKey } from "@rakazo/core";
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
  onConnect,
}: {
  bot: Bot;
  disabled?: boolean;
  onSaved: (bot: Bot) => void;
  /** Opens the model connections, offered when no provider is connected yet. */
  onConnect: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const credentials = useQuery(queries.models.credentials.queryOptions()).data;
  const catalog = useQuery(queries.models.list.queryOptions()).data;
  const me = useQuery(queries.me.queryOptions()).data;
  const onFailed = (error: Error) => toast.error(errorText(error, t`Could not change the model`));
  const saveModel = useSave({
    save: (key: string, client) => client.bots.update({ botId: bot.id, ...botModelPick(key) }),
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
  const {
    selectedModelKey,
    selectedName,
    selectedMark,
    choices,
    thinkingLevels,
    defaultThinkingLevel,
    nothingConnected,
  } = botModelState({
    credentials,
    catalog,
    me,
    modelKey: pendingModel ?? savedKey,
    spaceDefaultLabel: t`Space default`,
  });
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
  return (
    <ChatModelPicker
      compact
      choices={choices}
      value={selectedModelKey}
      // The button names the model alone (the one behind the Space default when the bot follows
      // it); the list keeps each row's full name.
      selectedLabel={selectedName}
      mark={selectedMark}
      detail={shownThinking}
      disabled={disabled || saveModel.pending || saveThinking.pending}
      onChange={(key) => {
        if (key !== selectedModelKey) saveModel.run(key);
      }}
      // A model with thinking levels keeps the panel open, so its level can be set next.
      // With no provider connected there is nothing to switch to, so the list offers a connection.
      onConnect={nothingConnected ? onConnect : undefined}
      staysOpen={(key) =>
        botModelState({ credentials, catalog, me, modelKey: key, spaceDefaultLabel: "" })
          .thinkingLevels.length > 0
      }
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
                        // A model save resets thinking, so a level picked meanwhile would be lost.
                        disabled={saveModel.pending}
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
