import { useLingui } from "@lingui/react/macro";
import type { Bot, ThinkingLevel } from "@rakazo/contracts";
import { botModelPick, botModelState, modelOptionKey } from "@rakazo/core";
import { localizeModelEntry } from "@rakazo/i18n/model-provider";
import { Command, CommandGroup, CommandItem, CommandList, Kbd, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { thinkingLevelLabel } from "../../../lib/models/model-catalog";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { ChatModelPicker } from "../chat/chat-model-picker";
import { chordKeys, chordLabel, isApplePlatform } from "../shell-shortcuts";

/** What the shell's keys can do with the picker while it is shown. */
export type ComposerModelKeys = {
  stepThinking: () => boolean;
  /** Whether the list may open now; closing it always may. */
  canOpen: () => boolean;
};

/**
 * The chat's model beside Send, for people who turned it on. Its panel lists the models with the
 * thinking levels beside them; each pick saves to the bot.
 */
export function ComposerModelPicker({
  bot,
  disabled,
  onSaved,
  onConnect,
  open,
  onOpenChange,
  onKeysChange,
}: {
  bot: Bot;
  disabled?: boolean;
  onSaved: (bot: Bot) => void;
  /** Opens the model connections, offered when no provider is connected yet. */
  onConnect: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Receives what the keyboard can do once the button is shown and usable, and null when it stops
   * being either, so the keys act only on a picker that is really there.
   */
  onKeysChange?: (keys: ComposerModelKeys | null) => void;
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

  // The shell's key press calls the latest step, which reads this render's levels.
  const thinkingStep = useRef<(() => boolean) | null>(null);
  const saving = useRef(false);
  const ready = Boolean(credentials && catalog && me) && !disabled;
  useEffect(() => {
    if (!ready) return;
    onKeysChange?.({
      stepThinking: () => thinkingStep.current?.() ?? false,
      canOpen: () => !saving.current,
    });
    return () => onKeysChange?.(null);
  }, [onKeysChange, ready]);

  if (!credentials || !catalog || !me) {
    thinkingStep.current = null;
    return null;
  }
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
    catalog: catalog.map(localizeModelEntry),
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
  const busy = disabled || saveModel.pending || saveThinking.pending;
  // A pick made mid-save would be dropped, so the key opens the list only when a click could.
  saving.current = busy;
  // Steps from the level in use (the default's when none is saved) to the next, wrapping. Landing
  // on the default's level saves Default, so the bot keeps following later default changes.
  thinkingStep.current =
    thinkingLevels.length && !busy
      ? () => {
          const current = thinkingLevels.findIndex(
            (level) => level === (thinking ?? defaultThinkingLevel),
          );
          const next = thinkingLevels[(current + 1) % thinkingLevels.length];
          if (next === undefined) return false;
          const value = next === defaultThinkingLevel ? null : next;
          // A model with one level has nowhere to step.
          if (value === thinking) return false;
          saveThinking.run(value);
          return true;
        }
      : null;
  const apple = isApplePlatform();
  const modelKeys = chordKeys({ apple }, "M", true);
  const thinkingKeys = chordKeys({ apple }, "E", true);
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
      disabled={busy}
      open={open}
      onOpenChange={onOpenChange}
      keyShortcuts={apple ? "Meta+Shift+M" : "Control+Shift+M"}
      hint={
        <>
          {t`Model`}
          <Kbd>{chordLabel({ apple }, modelKeys)}</Kbd>
          {thinkingLevels.length > 1 ? (
            <>
              <span className="ms-1">{t`Thinking`}</span>
              <Kbd>{chordLabel({ apple }, thinkingKeys)}</Kbd>
            </>
          ) : null}
        </>
      }
      onChange={(key) => {
        if (key !== selectedModelKey) saveModel.run(key);
      }}
      // A model with thinking levels keeps the panel open, so its level can be set next.
      // With no provider connected there is nothing to switch to, so the list offers a connection.
      onConnect={nothingConnected ? onConnect : undefined}
      staysOpen={(key) =>
        botModelState({
          credentials,
          catalog: catalog.map(localizeModelEntry),
          me,
          modelKey: key,
          spaceDefaultLabel: "",
        }).thinkingLevels.length > 0
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
