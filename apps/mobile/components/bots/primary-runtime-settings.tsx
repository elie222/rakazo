import { useLingui } from "@lingui/react/macro";
import type { RpcInput, RpcOutput } from "@rakazo/contracts";
import { useState } from "react";
import { formRead, rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { SettingsGroup, SettingsRow } from "../settings/settings-group";
import type { MenuPickerChoice } from "../ui/menu-picker";
import { MenuPicker } from "../ui/menu-picker";

type Settings = RpcOutput<"bots/primaryRuntime">;
type Write = RpcInput<"bots/setPrimaryRuntime">;
type Selection = Write["preference"];
type Draft = { value: Selection; base: Settings };

function sameBinding(a: Settings, b: Settings): boolean {
  return (
    a.revision === b.revision &&
    a.model.modelProvider === b.model.modelProvider &&
    a.model.modelId === b.model.modelId &&
    a.model.modelCredentialId === b.model.modelCredentialId
  );
}

export function usePrimaryRuntimeSettings(botId: string, enabled: boolean) {
  const read = formRead(rpcQuery("bots/primaryRuntime", { botId }));
  const query = useScreenQuery(read, { enabled });
  const settings = query.error ? undefined : query.data;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [conflict, setConflict] = useState(false);
  const save = useSave({
    save: (change: Draft, send) =>
      send("bots/setPrimaryRuntime", {
        botId,
        preference: change.value,
        expectedRevision: change.base.revision,
        expectedModel: change.base.model,
      }),
    stale: [read.queryKey],
    onSaved: (outcome) => {
      setConflict(outcome.status === "conflict");
      if (outcome.status !== "conflict") setDraft(null);
    },
  });
  return {
    settings,
    draft,
    readKey: read.queryKey,
    loadError: query.error,
    refreshing: query.isFetching,
    pending: save.pending,
    saveError: save.error,
    needsReview: conflict || Boolean(draft && settings && !sameBinding(draft.base, settings)),
    retry: () => void query.refetch(),
    choose(next: Selection) {
      if (!settings || save.pending || (next === "claude-agent" && !settings.canSelectClaude))
        return;
      save.reset();
      if (next === settings.preference) setConflict(false);
      setDraft(
        next === settings.preference ? null : { value: next, base: draft?.base ?? settings },
      );
    },
    review() {
      if (!settings || query.isFetching || save.pending || !draft) return;
      save.reset();
      setConflict(false);
      setDraft(draft.value === settings.preference ? null : { ...draft, base: settings });
    },
    submit(modelBindingEdited: boolean) {
      if (
        !draft ||
        !settings ||
        modelBindingEdited ||
        query.isFetching ||
        save.pending ||
        conflict ||
        !sameBinding(draft.base, settings) ||
        (draft.value === "claude-agent" && !settings.canSelectClaude)
      )
        return;
      save.run(draft);
    },
  };
}

export function PrimaryRuntimeSettings({
  runtime,
  modelBindingEdited,
  profilePending,
}: {
  runtime: ReturnType<typeof usePrimaryRuntimeSettings>;
  modelBindingEdited: boolean;
  profilePending: boolean;
}) {
  const { t } = useLingui();
  const { settings, draft, needsReview, refreshing, pending } = runtime;
  if (!settings) {
    if (!runtime.loadError || (runtime.loadError as { status?: number }).status === 404)
      return null;
    return (
      <SettingsGroup label={t`Execution runtime`}>
        <SettingsRow
          title={t`Could not load runtime settings`}
          detail={t`Try again`}
          onPress={runtime.retry}
          disabled={refreshing}
          accessibilityState={{ disabled: refreshing }}
        />
      </SettingsGroup>
    );
  }
  const preference = draft ? draft.value : settings.preference;
  const choice =
    preference === null
      ? "inherit"
      : preference === "pi" || preference === "claude-agent"
        ? preference
        : "unavailable";
  const choices: MenuPickerChoice[] = [
    { key: "inherit", label: t`Use default` },
    { key: "pi", label: t`Pi` },
    { key: "claude-agent", label: t`Claude Code`, disabled: !settings.canSelectClaude },
    ...(choice === "unavailable"
      ? [{ key: "unavailable", label: t`Unavailable runtime`, disabled: true }]
      : []),
  ];
  const label = (mode: Settings["direct"]) =>
    mode === "pi" ? t`Pi` : mode === "claude-agent" ? t`Claude Code` : t`Unavailable`;
  const waiting = pending || profilePending || refreshing;
  const blocked =
    waiting ||
    modelBindingEdited ||
    needsReview ||
    (draft?.value === "claude-agent" && !settings.canSelectClaude);
  return (
    <SettingsGroup
      label={t`Execution runtime`}
      footer={runtime.saveError ? t`Could not save the runtime. Try again.` : undefined}
    >
      <MenuPicker
        label={t`Runtime preference`}
        choices={choices}
        value={choice}
        disabled={waiting}
        onChange={(key) => {
          if (waiting) return;
          if (key === "inherit" || key === "pi" || key === "claude-agent")
            runtime.choose(key === "inherit" ? null : key);
        }}
      />
      <SettingsRow
        title={t`Saved model connection`}
        detail={settings.connectionLabel ?? t`No named connection`}
      />
      {settings.model.modelId ? (
        <SettingsRow title={t`Saved model`} detail={settings.model.modelId} />
      ) : null}
      <SettingsRow title={t`Direct chat`} detail={label(settings.direct)} />
      <SettingsRow title={t`Group chat`} detail={label(settings.group)} />
      {!settings.canSelectClaude ? (
        <SettingsRow
          title={t`Claude Code needs an available runtime and a named Anthropic API-key connection.`}
        />
      ) : null}
      {modelBindingEdited ? (
        <SettingsRow title={t`Save your model or connection changes before saving the runtime.`} />
      ) : needsReview && draft ? (
        <SettingsRow
          title={t`Keep my selection`}
          detail={t`The saved runtime or model connection changed. Review it before saving.`}
          disabled={waiting}
          accessibilityState={{ disabled: waiting }}
          onPress={runtime.review}
        />
      ) : null}
      {draft ? (
        <SettingsRow
          title={pending ? t`Saving runtime…` : t`Save runtime`}
          disabled={blocked}
          accessibilityState={{ disabled: blocked, busy: pending }}
          dimmed={blocked}
          onPress={() => {
            if (!profilePending) runtime.submit(modelBindingEdited);
          }}
        />
      ) : null}
    </SettingsGroup>
  );
}
