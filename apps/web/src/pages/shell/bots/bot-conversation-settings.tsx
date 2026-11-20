import { useLingui } from "@lingui/react/macro";
import type { Bot, ConversationCompactionMode } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { useSave } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import {
  ConversationCompactionRow,
  PanelSection,
  SettingsCard,
  ToolCallLimitRow,
} from "./bot-settings-sections";

export type ConversationSettingsPatch = {
  conversationCompactionMode?: ConversationCompactionMode;
  conversationCompactionTokens?: number | null;
  maxToolCallsPerTurn?: number | null;
};

/** The agent-work settings, saved independently of the profile and model fields. */
export function ConversationSettingsCard({
  bot,
  disabled,
  onSave,
}: {
  bot: Bot;
  disabled?: boolean;
  onSave: (patch: ConversationSettingsPatch) => Promise<void>;
}) {
  const { t } = useLingui();
  const [mode, setMode] = useState<ConversationCompactionMode>(
    bot.conversationCompactionMode ?? "automatic",
  );
  const [tokens, setTokens] = useState<number | null>(bot.conversationCompactionTokens ?? null);
  const [maxToolCalls, setMaxToolCalls] = useState<number | null>(bot.maxToolCallsPerTurn ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const save = useSave<ConversationSettingsPatch>({
    save: async (patch) => {
      setFailure(null);
      await onSave(patch);
    },
    onFailed: (error) => {
      setMode(bot.conversationCompactionMode ?? "automatic");
      setTokens(bot.conversationCompactionTokens ?? null);
      setMaxToolCalls(bot.maxToolCallsPerTurn ?? null);
      setFailure(errorText(error, t`Could not save`));
    },
  });

  // A newer server copy replaces the rows; a pending save's local edit survives until it lands.
  useEffect(() => {
    setMode(bot.conversationCompactionMode ?? "automatic");
    setTokens(bot.conversationCompactionTokens ?? null);
    setMaxToolCalls(bot.maxToolCallsPerTurn ?? null);
  }, [bot]);

  if (bot.conversationCompactionMode === undefined && bot.maxToolCallsPerTurn === undefined) {
    return null;
  }

  return (
    <PanelSection label={t`Conversation`}>
      <SettingsCard>
        <ConversationCompactionRow
          id="conversation-compaction"
          mode={mode}
          customTokens={tokens}
          disabled={disabled || save.pending}
          onChange={(nextMode, nextTokens) => {
            setMode(nextMode);
            setTokens(nextTokens);
            save.run({
              conversationCompactionMode: nextMode,
              conversationCompactionTokens: nextTokens,
            });
          }}
        />
        <ToolCallLimitRow
          id="tool-call-limit"
          value={maxToolCalls}
          disabled={disabled || save.pending}
          onCommit={(value) => {
            setMaxToolCalls(value);
            save.run({ maxToolCallsPerTurn: value });
          }}
        />
      </SettingsCard>
      {failure ? <p className="mt-2 text-body-sm text-destructive">{failure}</p> : null}
    </PanelSection>
  );
}
