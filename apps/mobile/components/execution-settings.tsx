import { useLingui } from "@lingui/react/macro";
import type { BotExecutionConfiguration, ExecutionConnectionView } from "@rakazo/contracts";
import { BotExecutionSchema, ExecutionConnectionSchema } from "@rakazo/contracts";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { captureApiRequestContext, rpc } from "../lib/api/api";
import { SettingsGroup, SettingsRow } from "./settings/settings-group";
import { MenuPicker } from "./ui/menu-picker";

export function ExecutionSettings({
  botId,
  children,
  ...groupProps
}: ComponentProps<typeof SettingsGroup> & { botId: string }) {
  const { t } = useLingui();
  const [connections, setConnections] = useState<ExecutionConnectionView[]>([]);
  const [configuration, setConfiguration] = useState<BotExecutionConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [requestContext, setRequestContext] =
    useState<Awaited<ReturnType<typeof captureApiRequestContext>>>();
  useEffect(() => {
    let active = true;
    setRefreshing(true);
    void (async () => {
      const context = await captureApiRequestContext();
      const [list, current] = await Promise.all([
        rpc("executions/list", { botId }, { requestContext: context }),
        rpc("executions/get", { botId }, { requestContext: context }),
      ]);
      const parsedConnections = ExecutionConnectionSchema.array().parse(list);
      const parsedConfiguration = BotExecutionSchema.nullable().parse(current);
      if (active) {
        setRequestContext(context);
        setConnections(parsedConnections);
        setConfiguration(parsedConfiguration);
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (active) setRefreshing(false);
      });
    return () => {
      active = false;
    };
  }, [botId, retry]);
  const options = connections.flatMap((c) =>
    c.profiles
      .filter((profile) => profile.status === "ready")
      .map((p) => ({
        key: JSON.stringify([c.id, p.id, p.revision]),
        label:
          connections
            .flatMap((item) => item.profiles)
            .filter((item) => item.status === "ready" && item.label === p.label).length > 1
            ? `${c.label} / ${p.label}`
            : p.label,
        profile: p,
        configuration: { connectionId: c.id, profileId: p.id, revision: p.revision, model: null },
      })),
  );
  const value = configuration
    ? JSON.stringify([configuration.connectionId, configuration.profileId, configuration.revision])
    : "";
  const profile = options.find((option) => option.key === value)?.profile;
  const models = new Map((profile?.models ?? []).map((model) => [model.id, model.label]));
  for (const model of [profile?.defaultModel, configuration?.model]) {
    if (model && !models.has(model)) models.set(model, model);
  }
  async function save(next: BotExecutionConfiguration | null, stopActiveRuns = false) {
    if (busy || !requestContext) return;
    setBusy(true);
    try {
      await rpc(
        "executions/configure",
        { botId, configuration: next, stopActiveRuns },
        { requestContext },
      );
      setConfiguration(next);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "CONFLICT" &&
        !stopActiveRuns
      ) {
        Alert.alert(
          t`Stop current tasks?`,
          t`Unfinished tasks will stop before the new agent settings are applied.`,
          [
            { text: t`Cancel`, style: "cancel" },
            {
              text: t`Stop and switch`,
              style: "destructive",
              onPress: () => void save(next, true),
            },
          ],
        );
      } else Alert.alert(t`Could not save agent settings`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {connections.length || configuration ? (
        <SettingsGroup label={t`Agent`}>
          <MenuPicker
            label={t`Agent`}
            showLabel={false}
            value={value}
            choices={[
              { key: "", label: t`Built-in` },
              ...options,
              ...(configuration && !options.some((o) => o.key === value)
                ? [{ key: value, label: t`Unavailable` }]
                : []),
            ]}
            onChange={(key) => {
              const option = options.find((option) => option.key === key);
              if (key && !option) return;
              void save(option?.configuration ?? null);
            }}
          />
          {connections.flatMap((connection) =>
            connection.online
              ? connection.profiles
                  .filter((profile) => profile.status !== "ready")
                  .map((profile) => (
                    <SettingsRow
                      key={`${connection.id}:${profile.id}`}
                      title={profile.label}
                      value={
                        profile.status === "missing"
                          ? t`Not installed`
                          : profile.status === "unsupported"
                            ? t`Unsupported version`
                            : profile.status === "unauthenticated"
                              ? t`Sign in required`
                              : profile.status === "stopped"
                                ? t`Computer stopped`
                                : profile.status === "unavailable"
                                  ? t`Model unavailable`
                                  : t`Verification required`
                      }
                    />
                  ))
              : [<SettingsRow key={connection.id} title={connection.label} value={t`Offline`} />],
          )}
          {connections.some(
            (connection) =>
              !connection.online ||
              connection.profiles.some((profile) => profile.status !== "ready"),
          ) ? (
            <SettingsRow
              title={t`Retry`}
              disabled={busy || refreshing}
              onPress={() => setRetry((value) => value + 1)}
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      <SettingsGroup {...groupProps}>
        {configuration ? (
          <MenuPicker
            showLabel={false}
            label={t`Model`}
            value={configuration.model ?? ""}
            choices={[
              {
                key: "",
                label: profile?.defaultModel
                  ? `${t`Default`} (${models.get(profile.defaultModel) ?? profile.defaultModel})`
                  : t`Default`,
              },
              ...[...models].map(([id, label]) => ({ key: id, label })),
            ]}
            onChange={(model) => void save({ ...configuration, model: model || null })}
          />
        ) : (
          children
        )}
      </SettingsGroup>
    </>
  );
}
