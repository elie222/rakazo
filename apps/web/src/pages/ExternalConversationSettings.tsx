import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AutomatedSenderPolicies,
  AutomatedSenderPolicyMode,
  Bot,
  ExternalConversation,
  ExternalConversationPolicy,
} from "@rakazo/contracts";
import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { BuiButton, SuccessPop } from "../components/beautiful-ui/primitives";

type ListenMode = "inherit" | "listen" | "mentions";

function listenMode(value: boolean | null): ListenMode {
  return value === null ? "inherit" : value ? "listen" : "mentions";
}

function ambientValue(mode: ListenMode): boolean | null {
  return mode === "inherit" ? null : mode === "listen";
}

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
    () =>
      [
        ...new Map([
          ...Object.entries(policies).map(
            ([id, policy]) => [id, { id, name: policy.name }] as const,
          ),
          ...conversation.automatedSenders.map((sender) => [sender.id, sender] as const),
        ]).values(),
      ].sort((left, right) => left.name.localeCompare(right.name)),
    [conversation.automatedSenders, policies],
  );
  const effectiveListening = ambientValue(mode) ?? bot.teamChatAmbientEnabled;
  const senderModes: Array<{ value: AutomatedSenderPolicyMode; label: string }> = [
    { value: "ignore", label: t`Ignore` },
    { value: "rollup", label: t`Group updates` },
    { value: "action", label: t`Always act` },
    { value: "user", label: t`Treat like a person` },
  ];

  function setSenderMode(
    senderId: string,
    senderName: string,
    nextMode: AutomatedSenderPolicyMode,
  ) {
    setSaved(false);
    setPolicies((current) => ({
      ...current,
      [senderId]: {
        name: senderName,
        mode: nextMode,
        ...(nextMode === "rollup" ? { rollupHours: current[senderId]?.rollupHours ?? 6 } : {}),
      },
    }));
  }

  return (
    <div data-testid="external-conversation-settings">
      <div className="mb-6">
        <h2 className="truncate text-[17px] font-medium text-[var(--rk-ink)]" dir="auto">
          {conversation.displayName || t`Slack conversation`}
        </h2>
        <p className="mt-1 truncate text-[12.5px] text-[var(--rk-muted-2)]">
          {conversation.participantNames.join(", ")}
        </p>
      </div>

      <fieldset>
        <legend className="text-[13.5px] text-[var(--rk-muted)]">
          <Trans>Listening</Trans>
        </legend>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-[var(--rk-surface)] p-1">
          {(
            [
              { value: "inherit" as const, label: t`${bot.name} default` },
              { value: "listen" as const, label: t`Listen` },
              { value: "mentions" as const, label: t`Mentions only` },
            ] satisfies Array<{ value: ListenMode; label: string }>
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={mode === option.value}
              onClick={() => {
                setMode(option.value);
                setSaved(false);
              }}
              className={`min-h-9 rounded-md px-2 text-[12px] leading-4 transition-colors ${
                mode === option.value
                  ? "bg-[var(--rk-elevated)] text-[var(--rk-ink)] shadow-sm"
                  : "text-[var(--rk-muted)] hover:text-[var(--rk-ink)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mt-6 block text-[13.5px] text-[var(--rk-muted)]">
        <span className="flex items-center justify-between gap-3">
          <Trans>Room guidance</Trans>
          {rules !== null ? (
            <button
              type="button"
              title={t`Use default guidance`}
              aria-label={t`Use default guidance`}
              onClick={() => {
                setRules(null);
                setSaved(false);
              }}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[var(--rk-muted)] hover:bg-[var(--rk-surface)] hover:text-[var(--rk-ink)]"
            >
              <RotateCcw size={14} strokeWidth={1.8} />
            </button>
          ) : (
            <span className="text-[11.5px] text-[var(--rk-muted-2)]">
              <Trans>{bot.name} default</Trans>
            </span>
          )}
        </span>
        <textarea
          value={rules ?? bot.teamChatRules}
          maxLength={4000}
          onChange={(event) => {
            setRules(event.target.value);
            setSaved(false);
          }}
          placeholder={t`Engage when... Ignore...`}
          rows={6}
          className="mt-2 w-full resize-y rounded-lg border border-[var(--rk-border)] bg-transparent px-3 py-2.5 text-[13.5px] leading-5 text-[var(--rk-ink)] outline-none focus:border-[var(--rk-muted-2)]"
        />
      </label>

      <div className="mt-6 border-t border-[var(--rk-border)] pt-5">
        <h3 className="text-[13.5px] text-[var(--rk-muted)]">
          <Trans>Automated senders</Trans>
        </h3>
        {senders.length > 0 ? (
          <div className="mt-2 divide-y divide-[var(--rk-border)]">
            {senders.map((sender) => {
              const policy = policies[sender.id] ?? {
                name: sender.name,
                mode: "ignore" as const,
              };
              return (
                <div key={sender.id} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-[13.5px] text-[var(--rk-ink)]">
                      {sender.name}
                    </span>
                    <select
                      aria-label={t`${sender.name} handling`}
                      value={policy.mode}
                      onChange={(event) =>
                        setSenderMode(
                          sender.id,
                          sender.name,
                          event.target.value as AutomatedSenderPolicyMode,
                        )
                      }
                      className="max-w-[165px] rounded-md border border-[var(--rk-border)] bg-[var(--rk-panel)] px-2 py-1.5 text-[12.5px] text-[var(--rk-ink)]"
                    >
                      {senderModes.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {policy.mode === "rollup" ? (
                    <label className="mt-2 flex items-center justify-end gap-2 text-[12px] text-[var(--rk-muted)]">
                      <Trans>Every</Trans>
                      <input
                        aria-label={t`${sender.name} rollup hours`}
                        type="number"
                        min={1}
                        max={720}
                        value={policy.rollupHours ?? 6}
                        onChange={(event) => {
                          const rollupHours = Math.max(
                            1,
                            Math.min(720, Number(event.target.value)),
                          );
                          setPolicies((current) => ({
                            ...current,
                            [sender.id]: { name: sender.name, mode: "rollup", rollupHours },
                          }));
                          setSaved(false);
                        }}
                        className="w-16 rounded-md border border-[var(--rk-border)] bg-transparent px-2 py-1 text-end text-[12.5px] text-[var(--rk-ink)]"
                      />
                      <Trans>hours</Trans>
                    </label>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-2 text-[12.5px] leading-5 text-[var(--rk-muted-2)]">
            <Trans>Automated senders will appear after they post here.</Trans>
          </p>
        )}
      </div>

      {!effectiveListening ? (
        <p className="mt-5 text-[12.5px] leading-5 text-[var(--rk-muted-2)]">
          <Trans>{bot.name} will still respond to direct mentions.</Trans>
        </p>
      ) : null}
      {error ? <p className="mt-3 text-[13px] text-[var(--rk-danger)]">{error}</p> : null}
      <div className="mt-6 flex min-h-10 items-center gap-3">
        <BuiButton
          tone="accent"
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
              .catch((cause) =>
                setError(cause instanceof Error ? cause.message : t`Could not save`),
              )
              .finally(() => setSaving(false));
          }}
        >
          {saving ? <Trans>Saving...</Trans> : <Trans>Save</Trans>}
        </BuiButton>
        {saved ? <SuccessPop label={t`Saved`} /> : null}
      </div>
    </div>
  );
}
