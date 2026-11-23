import { useLingui } from "@lingui/react/macro";
import type { Bot, ConversationCompactionMode } from "@rakazo/contracts";
import {
  DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS,
  DEFAULT_MAX_CONCURRENT_HELPERS,
  MAX_CONCURRENT_HELPERS_LIMIT,
  MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS,
  MAX_TOOL_CALLS_PER_TURN_LIMIT,
  MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../../lib/api/user-error";
import { useConversationCompactionChoices } from "../../lib/bots/bot-settings-choices";
import { useSave } from "../../lib/query/query";
import { SettingsGroup, SettingsInputRow } from "../settings/settings-group";
import { MenuPicker } from "../ui/menu-picker";

type Draft = {
  maxConcurrentHelpers: number | null;
  conversationCompactionMode: ConversationCompactionMode;
  conversationCompactionTokens: number | null;
  maxToolCallsPerTurn: number | null;
};

function draftFromBot(bot: Bot): Draft {
  return {
    maxConcurrentHelpers: bot.maxConcurrentHelpers ?? null,
    conversationCompactionMode: bot.conversationCompactionMode ?? "automatic",
    conversationCompactionTokens: bot.conversationCompactionTokens ?? null,
    maxToolCallsPerTurn: bot.maxToolCallsPerTurn ?? null,
  };
}

/** Background work, conversation compaction and the per-turn tool limit. */
export function BotAgentSettings({
  bot,
  onError,
}: {
  bot: Bot;
  onError: (message: string) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => draftFromBot(bot));
  const [tasksAtOnce, setTasksAtOnce] = useState(
    String(bot.maxConcurrentHelpers ?? DEFAULT_MAX_CONCURRENT_HELPERS),
  );
  const [compactionTokens, setCompactionTokens] = useState(
    bot.conversationCompactionTokens ? String(bot.conversationCompactionTokens) : "",
  );
  const [maxToolCalls, setMaxToolCalls] = useState(
    bot.maxToolCallsPerTurn ? String(bot.maxToolCallsPerTurn) : "",
  );
  const compactionChoices = useConversationCompactionChoices();
  const save = useSave<Draft>({
    save: async (value, send) => {
      await send("bots/update", { botId: bot.id, ...value });
    },
    onFailed: (error) => {
      const next = draftFromBot(bot);
      setDraft(next);
      setTasksAtOnce(String(next.maxConcurrentHelpers ?? DEFAULT_MAX_CONCURRENT_HELPERS));
      setCompactionTokens(
        next.conversationCompactionTokens ? String(next.conversationCompactionTokens) : "",
      );
      setMaxToolCalls(next.maxToolCallsPerTurn ? String(next.maxToolCallsPerTurn) : "");
      onError(errorText(error, t`Could not save agent settings`));
    },
  });
  // A field can commit while another save is in flight, and `run` drops that call. Keep the
  // newest draft and send it once the save finishes, so a later edit is never only on screen.
  const queued = useRef<Draft | null>(null);
  useEffect(() => {
    if (save.pending || !queued.current) return;
    const next = queued.current;
    queued.current = null;
    if (save.input === next) return;
    save.run(next);
  }, [save.pending, save.input, save.run]);

  useEffect(() => {
    const next = draftFromBot(bot);
    setDraft(next);
    setTasksAtOnce(String(next.maxConcurrentHelpers ?? DEFAULT_MAX_CONCURRENT_HELPERS));
    setCompactionTokens(
      next.conversationCompactionTokens ? String(next.conversationCompactionTokens) : "",
    );
    setMaxToolCalls(next.maxToolCallsPerTurn ? String(next.maxToolCallsPerTurn) : "");
  }, [bot]);

  function change(patch: Partial<Draft>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    onError("");
    queued.current = next;
    if (!save.pending) save.run(next);
  }

  function commitTasksAtOnce() {
    const parsed = tasksAtOnce.trim() ? Number(tasksAtOnce.trim()) : DEFAULT_MAX_CONCURRENT_HELPERS;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENT_HELPERS_LIMIT) {
      onError(t`Use a whole number from 1 to ${MAX_CONCURRENT_HELPERS_LIMIT}.`);
      return;
    }
    const value = parsed === DEFAULT_MAX_CONCURRENT_HELPERS ? null : parsed;
    setTasksAtOnce(String(parsed));
    if (value !== draft.maxConcurrentHelpers) change({ maxConcurrentHelpers: value });
  }

  function commitCompactionTokens() {
    const parsed = compactionTokens.trim()
      ? Number(compactionTokens.trim())
      : DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS;
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS ||
      parsed > MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS
    ) {
      onError(
        t`Use a whole number from ${MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS} to ${MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS}.`,
      );
      return;
    }
    setCompactionTokens(String(parsed));
    if (parsed !== draft.conversationCompactionTokens)
      change({ conversationCompactionTokens: parsed });
  }

  function commitMaxToolCalls() {
    const value = maxToolCalls.trim() ? Number(maxToolCalls.trim()) : null;
    if (
      value !== null &&
      (!Number.isInteger(value) || value < 1 || value > MAX_TOOL_CALLS_PER_TURN_LIMIT)
    ) {
      onError(t`Use a whole number from 1 to ${MAX_TOOL_CALLS_PER_TURN_LIMIT}.`);
      return;
    }
    if (value !== draft.maxToolCallsPerTurn) change({ maxToolCallsPerTurn: value });
  }

  return (
    <>
      <SettingsGroup label={t`Background work`}>
        <SettingsInputRow
          accessibilityLabel={t`Tasks at once`}
          placeholder={t`Tasks at once`}
          keyboardType="number-pad"
          value={tasksAtOnce}
          onChangeText={setTasksAtOnce}
          editable={!save.pending}
          onBlur={commitTasksAtOnce}
        />
      </SettingsGroup>
      <SettingsGroup
        label={t`Conversation`}
        footer={t`Summarizes when the prompt reaches the chosen share of the model's context window.`}
      >
        <MenuPicker
          choices={compactionChoices}
          label={t`Compact conversation`}
          disabled={save.pending}
          onChange={(key) => {
            const mode = key as ConversationCompactionMode;
            const tokens =
              mode === "custom"
                ? (draft.conversationCompactionTokens ??
                  DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS)
                : null;
            if (mode === "custom" && !compactionTokens.trim()) setCompactionTokens(String(tokens));
            change({ conversationCompactionMode: mode, conversationCompactionTokens: tokens });
          }}
          value={draft.conversationCompactionMode}
        />
        {draft.conversationCompactionMode === "custom" ? (
          <SettingsInputRow
            accessibilityLabel={t`Tokens`}
            placeholder={t`Tokens`}
            keyboardType="number-pad"
            value={compactionTokens}
            onChangeText={setCompactionTokens}
            editable={!save.pending}
            onBlur={commitCompactionTokens}
          />
        ) : null}
      </SettingsGroup>
      <SettingsGroup
        label={t`Task limit`}
        footer={t`The agent stops after this many tool calls in one turn. Empty means no limit.`}
      >
        <SettingsInputRow
          accessibilityLabel={t`Tool calls per turn`}
          placeholder={t`No limit`}
          keyboardType="number-pad"
          value={maxToolCalls}
          onChangeText={setMaxToolCalls}
          editable={!save.pending}
          onBlur={commitMaxToolCalls}
        />
      </SettingsGroup>
    </>
  );
}
