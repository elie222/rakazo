import { Trans, useLingui } from "@lingui/react/macro";
import type { BotExecutionConfiguration, ExecutionConnectionView } from "@rakazo/contracts";
import type { ChatModelChoice } from "@rakazo/core";
import { Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { useSpaceQueries } from "../lib/query/query";
import { useSpaceRpc } from "../lib/query/space-rpc";
import { errorCode, errorText } from "../lib/query/user-error";
import { ConfirmDialog } from "./ConfirmDialog";
import { HostExecutionTarget } from "./HostExecutionTarget";
import { useHostExecutionSettings } from "./use-host-execution-settings";

/** Advanced configuration stays beside the model it replaces. Electron shares this screen. */
export function ExecutionSettings({
  botId,
  children,
}: {
  botId: string;
  children: (
    model: {
      choices: readonly ChatModelChoice[];
      value: string;
      onChange: (key: string) => void;
    } | null,
  ) => ReactNode;
}) {
  const { t } = useLingui();
  const ids = useId();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const local = useHostExecutionSettings(botId);
  const list = useQuery(queries.executions.list.queryOptions({ input: { botId } }));
  const saved = useQuery(queries.executions.get.queryOptions({ input: { botId } }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<{ configuration: BotExecutionConfiguration | null }>();
  const needsRetry =
    local.error ||
    local.profiles.some((profile) => profile.status !== "ready") ||
    (!local.selected &&
      (list.data ?? []).some(
        (connection) =>
          !connection.online || connection.profiles.some((profile) => profile.status !== "ready"),
      ));
  const profileStatus = (status: ExecutionConnectionView["profiles"][number]["status"]) =>
    status === "missing"
      ? t`Not installed`
      : status === "unsupported"
        ? t`Unsupported version`
        : status === "unauthenticated"
          ? t`Sign in required`
          : status === "stopped"
            ? t`Computer stopped`
            : t`Model unavailable`;
  const options = (list.data ?? []).flatMap((connection) =>
    connection.profiles
      .filter((profile) => profile.status === "ready")
      .map((profile) => ({
        key: JSON.stringify([connection.id, profile.id, profile.revision]),
        label:
          (list.data ?? [])
            .flatMap((item) => item.profiles)
            .filter((item) => item.status === "ready" && item.label === profile.label).length > 1
            ? `${connection.label} / ${profile.label}`
            : profile.label,
        profile,
        configuration: {
          connectionId: connection.id,
          profileId: profile.id,
          revision: profile.revision,
          model: null,
        },
      })),
  );
  const value = local.selected
    ? `device:${local.selected.profileId}`
    : saved.data
      ? JSON.stringify([saved.data.connectionId, saved.data.profileId, saved.data.revision])
      : "";
  const profile = options.find((option) => option.key === value)?.profile;
  const models = new Map((profile?.models ?? []).map((model) => [model.id, model.label]));
  for (const model of [profile?.defaultModel, saved.data?.model]) {
    if (model && !models.has(model)) models.set(model, model);
  }
  async function save(configuration: BotExecutionConfiguration | null, stopActiveRuns = false) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (local.selected && stopActiveRuns) {
        await local.stop();
      }
      await rpc.executions.configure({ botId, configuration, stopActiveRuns });
      if (local.selected) await local.select(null);
      setPending(undefined);
      await saved.refetch();
    } catch (error) {
      if (errorCode(error) === "CONFLICT" && !stopActiveRuns) setPending({ configuration });
      else setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {list.data?.length || saved.data || local.profiles.length || local.selected || local.error ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-label font-medium text-muted-foreground" htmlFor={ids}>
              <Trans>Agent</Trans>
            </label>
            <div className="flex items-center gap-1">
              {needsRetry ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={list.isFetching}
                  onClick={() => void Promise.all([list.refetch(), local.retry()])}
                >
                  <Trans>Retry</Trans>
                </Button>
              ) : null}
            </div>
          </div>
          <NativeSelect
            className="w-full"
            id={ids}
            value={value}
            disabled={busy || local.loading}
            onChange={async (event) => {
              const value = event.target.value;
              if (value.startsWith("device:")) {
                setBusy(true);
                setError(undefined);
                try {
                  await local.select(value.slice(7));
                } catch (error) {
                  setError(errorText(error));
                } finally {
                  setBusy(false);
                }
                return;
              }
              const option = options.find((option) => option.key === value);
              if (!value || option) void save(option?.configuration ?? null);
            }}
          >
            <NativeSelectOption value="">
              <Trans>Built-in</Trans>
            </NativeSelectOption>
            {saved.data && !local.selected && !options.some((o) => o.key === value) ? (
              <NativeSelectOption value={value}>
                <Trans>Unavailable</Trans>
              </NativeSelectOption>
            ) : null}
            {options.map((option) => (
              <NativeSelectOption key={option.key} value={option.key}>
                {option.label}
              </NativeSelectOption>
            ))}
            {local.profiles.map((profile) => (
              <NativeSelectOption
                key={`device:${profile.id}`}
                value={`device:${profile.id}`}
                disabled={profile.status !== "ready"}
              >
                {profile.label}
                {profile.status !== "ready" ? ` · ${profileStatus(profile.status)}` : ""}
              </NativeSelectOption>
            ))}
            {(list.data ?? []).flatMap((connection) =>
              connection.profiles
                .filter((profile) => profile.status !== "ready")
                .map((profile) => (
                  <NativeSelectOption
                    key={`${connection.id}:${profile.id}`}
                    value={`pending:${connection.id}:${profile.id}`}
                    disabled
                  >
                    {profile.label} · {profileStatus(profile.status)}
                  </NativeSelectOption>
                )),
            )}
            {(list.data ?? [])
              .filter((connection) => !connection.online)
              .map((connection) => (
                <NativeSelectOption key={connection.id} value={`offline:${connection.id}`} disabled>
                  {connection.label} · <Trans>Offline</Trans>
                </NativeSelectOption>
              ))}
          </NativeSelect>
          {local.selected ? (
            <HostExecutionTarget
              selection={local.selected}
              busy={busy}
              onChange={async (target) => {
                setBusy(true);
                setError(undefined);
                try {
                  await local.select(local.selected!.profileId, target);
                } catch (error) {
                  setError(errorText(error));
                } finally {
                  setBusy(false);
                }
              }}
            />
          ) : null}
          {(error || local.error) && !pending ? (
            <p role="alert" className="text-body-sm text-destructive">
              {error ?? errorText(local.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      {!local.selected ? (
        <fieldset disabled={busy || local.loading} className="min-w-0">
          {children(
            saved.data
              ? {
                  choices: [
                    {
                      key: "",
                      label: profile?.defaultModel
                        ? `${t`Default`} (${models.get(profile.defaultModel) ?? profile.defaultModel})`
                        : t`Default`,
                    },
                    ...[...models].map(([key, label]) => ({ key, label })),
                  ],
                  value: saved.data.model ?? "",
                  onChange: (model) => void save({ ...saved.data!, model: model || null }),
                }
              : null,
          )}
        </fieldset>
      ) : null}
      {pending !== undefined ? (
        <ConfirmDialog
          open={pending !== undefined}
          title={t`Stop current tasks?`}
          description={t`Unfinished tasks will stop before the new agent settings are applied.`}
          confirmLabel={t`Stop and switch`}
          variant="default"
          busy={busy}
          error={error}
          onCancel={() => {
            setPending(undefined);
            setError(undefined);
          }}
          onConfirm={() => {
            if (pending) void save(pending.configuration, true);
          }}
        />
      ) : null}
    </>
  );
}
