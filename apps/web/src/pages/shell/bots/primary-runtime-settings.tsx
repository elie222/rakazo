import { Trans, useLingui } from "@lingui/react/macro";
import { Button, OptionSelect } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import type { RpcClient } from "../../../lib/query/rpc";

type Settings = Awaited<ReturnType<RpcClient["bots"]["primaryRuntime"]>>;
type Selection = Parameters<RpcClient["bots"]["setPrimaryRuntime"]>[0]["preference"];

type Draft = { value: Selection; base: Settings };
const sameModel = (a: Settings["model"], b: Settings["model"]) =>
  a.modelProvider === b.modelProvider &&
  a.modelId === b.modelId &&
  a.modelCredentialId === b.modelCredentialId;

export function PrimaryRuntimeSettings({
  botId,
  updatedAt,
  enabled,
}: {
  botId: string;
  updatedAt: string;
  enabled: boolean;
}) {
  const { t } = useLingui();
  const id = useId();
  const queries = useSpaceQueries();
  const cache = useQueryClient();
  const options = queries.bots.primaryRuntime.queryOptions({ input: { botId } });
  const { data: settings, refetch } = useQuery({
    ...options,
    enabled,
    refetchOnWindowFocus: "always",
  });
  const lastBotUpdate = useRef(updatedAt);
  useEffect(() => {
    if (!enabled || lastBotUpdate.current === updatedAt) return;
    lastBotUpdate.current = updatedAt;
    void refetch();
  }, [enabled, refetch, updatedAt]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState(false);
  const save = useSave({
    save: (change: Draft, rpc) =>
      rpc.bots.setPrimaryRuntime({
        botId,
        preference: change.value,
        expectedRevision: change.base.revision,
        expectedModel: change.base.model,
      }),
    onSaved: async (outcome) => {
      await cache.cancelQueries({ queryKey: options.queryKey, exact: true });
      cache.setQueryData(options.queryKey, (current) =>
        current && current.revision > outcome.settings.revision ? current : outcome.settings,
      );
      if (outcome.status === "conflict") setConflict(true);
      else {
        setConflict(false);
        setDraft(null);
      }
      await cache.invalidateQueries({ queryKey: options.queryKey, exact: true });
    },
  });
  // The server returns no owner settings to other members. Keep the existing bot panel usable.
  if (!settings) return null;
  const value = (draft ? draft.value : settings.preference) ?? "inherit";
  const needsReview =
    conflict ||
    (draft !== null &&
      (draft.base.revision !== settings.revision || !sameModel(draft.base.model, settings.model)));
  const cannotSelect =
    draft?.value === "claude-agent" &&
    settings.preference !== "claude-agent" &&
    !settings.canSelectClaude;
  const label = (runtime: Settings["direct"]) =>
    runtime === "pi" ? t`Pi` : runtime === "claude-agent" ? t`Claude Code` : t`Unavailable`;
  const choices = [
    { value: "inherit", label: t`Use default` },
    { value: "pi", label: t`Pi` },
    { value: "claude-agent", label: t`Claude Code`, disabled: !settings.canSelectClaude },
    ...(value !== "inherit" && value !== "pi" && value !== "claude-agent"
      ? [{ value, label: t`Unavailable runtime`, disabled: true }]
      : []),
  ];
  return (
    <div className="space-y-2 py-2">
      <div className="flex min-h-12 items-center justify-between gap-3">
        <label htmlFor={id}>
          <Trans>Execution runtime</Trans>
        </label>
        <OptionSelect
          id={id}
          className="w-fit max-w-2/3"
          value={value}
          options={choices}
          onValueChange={(choice) => {
            if (save.pending) return;
            if (choice !== "pi" && choice !== "claude-agent" && choice !== "inherit") return;
            const next = choice === "inherit" ? null : choice;
            save.reset();
            setDraft(
              next === settings.preference ? null : { value: next, base: draft?.base ?? settings },
            );
            if (next === settings.preference) setConflict(false);
          }}
        />
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        <Trans>
          Direct chat: {label(settings.direct)}. Group chat: {label(settings.group)}.
        </Trans>
      </p>
      {settings.connectionLabel ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Saved model connection: {settings.connectionLabel}</Trans>
        </p>
      ) : null}
      {!settings.canSelectClaude ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Claude Code needs an available runtime and a named Anthropic API-key connection.
          </Trans>
        </p>
      ) : null}
      {needsReview ? (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            <Trans>
              The runtime or model connection changed. Review the latest settings before saving.
            </Trans>
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={save.pending}
            onClick={() => {
              setConflict(false);
              if (draft)
                setDraft(draft.value === settings.preference ? null : { ...draft, base: settings });
            }}
          >
            <Trans>Keep my selection</Trans>
          </Button>
        </div>
      ) : null}
      {save.error ? (
        <p role="alert" className="text-sm">
          <Trans>Unable to save the runtime. Check your connection and try again.</Trans>
        </p>
      ) : null}
      {draft ? (
        <Button
          type="button"
          size="sm"
          disabled={save.pending || needsReview || cannotSelect}
          onClick={() => save.run(draft)}
        >
          {save.pending ? <Trans>Saving runtime…</Trans> : <Trans>Save runtime</Trans>}
        </Button>
      ) : null}
    </div>
  );
}
