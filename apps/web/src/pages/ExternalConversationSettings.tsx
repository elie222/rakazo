import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AutomatedSenderPolicies,
  AutomatedSenderPolicyMode,
  Bot,
  ExternalConversation,
  ExternalConversationPolicy,
} from "@rakazo/contracts";
import type { ListenMode } from "@rakazo/core";
import {
  AUTOMATED_SENDER_MODES,
  ambientValue,
  listenMode,
  roomAutomatedSenders,
  senderPolicy,
  withRollupHours,
  withSenderMode,
} from "@rakazo/core";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { RotateCcw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { SuccessPop } from "../components/ai/primitives";
import { IconTooltip } from "../components/IconTooltip";
import { errorText } from "../lib/user-error";

export function ExternalConversationSettings({
  conversation,
  bot,
  onSave,
}: {
  conversation: ExternalConversation;
  bot: Bot;
  onSave: (policy: ExternalConversationPolicy) => Promise<void>;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const [mode, setMode] = useState<ListenMode>(() =>
    listenMode(conversation.teamChatAmbientEnabled),
  );
  const [rules, setRules] = useState<string | null>(conversation.teamChatRules);
  const [policies, setPolicies] = useState<AutomatedSenderPolicies>(
    conversation.automatedSenderPolicies,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const senders = useMemo(
    () => roomAutomatedSenders(policies, conversation.automatedSenders),
    [conversation.automatedSenders, policies],
  );
  const effectiveListening = ambientValue(mode) ?? bot.teamChatAmbientEnabled;
  const senderModeLabels: Record<AutomatedSenderPolicyMode, string> = {
    ignore: t`Ignore`,
    rollup: t`Group updates`,
    action: t`Always act`,
    user: t`Treat like a person`,
  };

  function updatePolicies(update: (current: AutomatedSenderPolicies) => AutomatedSenderPolicies) {
    setSaved(false);
    setPolicies(update);
  }

  return (
    <div data-testid="external-conversation-settings">
      <div className="mb-6">
        <h2 className="truncate text-[17px] font-medium text-foreground" dir="auto">
          {conversation.displayName || t`External conversation`}
        </h2>
        <p className="mt-1 truncate text-[12.5px] text-muted-foreground">
          {conversation.participantNames.join(", ")}
        </p>
      </div>

      <div>
        <span id={`${fieldId}-listening`} className="text-[13.5px] text-muted-foreground">
          <Trans>Listening</Trans>
        </span>
        <ToggleGroup
          aria-labelledby={`${fieldId}-listening`}
          value={[mode]}
          onValueChange={([next]) => {
            if (!next) return;
            setMode(next as ListenMode);
            setSaved(false);
          }}
          spacing={1}
          className="mt-2 grid w-full grid-cols-3 rounded-lg bg-muted/40 p-1"
        >
          {(
            [
              { value: "inherit" as const, label: t`${bot.name} default` },
              { value: "listen" as const, label: t`Listen` },
              { value: "mentions" as const, label: t`Mentions only` },
            ] satisfies Array<{ value: ListenMode; label: string }>
          ).map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              className="h-auto min-h-9 whitespace-normal rounded-md px-2 text-[12px] leading-4 font-normal text-muted-foreground hover:bg-transparent aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <label
        htmlFor={`${fieldId}-rules`}
        className="mt-6 block text-[13.5px] text-muted-foreground"
      >
        <span className="flex items-center justify-between gap-3">
          <Trans>Room guidance</Trans>
          {rules !== null ? (
            <IconTooltip label={t`Use default guidance`}>
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={t`Use default guidance`}
                onClick={() => {
                  setRules(null);
                  setSaved(false);
                }}
                className="shrink-0 text-muted-foreground"
              >
                <RotateCcw size={14} strokeWidth={1.8} />
              </Button>
            </IconTooltip>
          ) : (
            <span className="text-[11.5px] text-muted-foreground/70">
              <Trans>{bot.name} default</Trans>
            </span>
          )}
        </span>
        <Textarea
          id={`${fieldId}-rules`}
          value={rules ?? bot.teamChatRules}
          maxLength={4000}
          onChange={(event) => {
            setRules(event.target.value);
            setSaved(false);
          }}
          placeholder={t`Engage when... Ignore...`}
          rows={6}
          className="mt-2 min-h-36 resize-y"
        />
      </label>

      <div className="mt-6 border-t border-border pt-5">
        <h3 className="text-[13.5px] text-muted-foreground">
          <Trans>Automated senders</Trans>
        </h3>
        {senders.length > 0 ? (
          <div className="mt-2 divide-y divide-border">
            {senders.map((sender) => {
              const policy = senderPolicy(policies, sender);
              return (
                <div key={sender.id} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-[13.5px] text-foreground">
                      {sender.name}
                    </span>
                    <NativeSelect
                      size="sm"
                      aria-label={t`${sender.name} handling`}
                      value={policy.mode}
                      onChange={(event) =>
                        updatePolicies((current) =>
                          withSenderMode(
                            current,
                            sender,
                            event.target.value as AutomatedSenderPolicyMode,
                          ),
                        )
                      }
                      className="max-w-[165px]"
                    >
                      {AUTOMATED_SENDER_MODES.map((value) => (
                        <NativeSelectOption key={value} value={value}>
                          {senderModeLabels[value]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  {policy.mode === "rollup" ? (
                    <label
                      htmlFor={`${fieldId}-${sender.id}-rollup`}
                      className="mt-2 flex items-center justify-end gap-2 text-[12px] text-muted-foreground"
                    >
                      <Trans>Every</Trans>
                      <Input
                        id={`${fieldId}-${sender.id}-rollup`}
                        aria-label={t`${sender.name} rollup hours`}
                        type="number"
                        min={1}
                        max={720}
                        value={policy.rollupHours ?? 6}
                        onChange={(event) =>
                          updatePolicies((current) =>
                            withRollupHours(current, sender, Number(event.target.value)),
                          )
                        }
                        className="h-7 w-16 px-2 text-end"
                      />
                      <Trans>hours</Trans>
                    </label>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 text-[12.5px] leading-5 text-muted-foreground/70">
            <Trans>Automated senders will appear after they post here.</Trans>
          </p>
        )}
      </div>

      {!effectiveListening ? (
        <p className="mt-5 text-[12.5px] leading-5 text-muted-foreground/70">
          <Trans>{bot.name} will still respond to direct mentions.</Trans>
        </p>
      ) : null}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
      <div className="mt-6 flex min-h-10 items-center gap-3">
        <Button
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setSaved(false);
            setError(null);
            void onSave({
              teamChatAmbientEnabled: ambientValue(mode),
              teamChatRules: rules,
              automatedSenderPolicies: policies,
            })
              .then(() => setSaved(true))
              .catch((cause) => setError(errorText(cause, t`Could not save`)))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? <Trans>Saving...</Trans> : <Trans>Save</Trans>}
        </Button>
        {saved ? <SuccessPop label={t`Saved`} /> : null}
      </div>
    </div>
  );
}
