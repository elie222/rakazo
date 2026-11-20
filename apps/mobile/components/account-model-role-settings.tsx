import type { MenuAction } from "@expo/ui/community/menu";
import type {
  ModelCredential,
  ModelRole,
  ModelRoleChoice,
  RpcInput,
  RpcPath,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
  modelRoleChoiceKey,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { createAccountModelRole } from "@rakazo/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AccessibilityInfo, StyleSheet, Text } from "react-native";
import type { RpcArgs } from "../lib/api/api";
import { captureApiRequestContext, currentApiBase, rpc } from "../lib/api/api";
import { mobileTokens } from "../lib/appearance/appearance";
import { useI18n } from "../lib/model-account-i18n";
import type { ModelPickerRequest } from "../lib/models/model-picker-selection";
import { thinkingLevelLabel } from "../lib/models/thinking-level";
import { useThemedStyles } from "../lib/native/native";
import { RowMenu } from "./models/model-role-settings";
import { SettingsGroup, SettingsRow } from "./settings/settings-group";

export function ModelRoleSettings({
  userId,
  spaceId,
  scope,
  modelRole: role,
  credentials,
  title,
  defaultLabel,
  openPicker,
  onChanged,
}: {
  userId: string;
  spaceId: string;
  scope: SettingsScope;
  modelRole: ModelRole;
  credentials: ModelCredential[];
  title: string;
  defaultLabel: string;
  openPicker: (request: ModelPickerRequest) => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const apiBase = currentApiBase();
  const styles = useThemedStyles(() =>
    StyleSheet.create({ error: { color: mobileTokens().destructive, padding: 16 } }),
  );
  const controller = useMemo(() => {
    const requestContext = captureApiRequestContext(spaceId);
    const send = async <P extends RpcPath>(proc: P, input: RpcInput<P>) =>
      rpc(proc, ...([input, { requestContext: await requestContext }] as RpcArgs<P>));
    const target = { role, expectedUserId: userId };
    return createAccountModelRole(
      {
        load: () => send("models/role", { ...target, scope }),
        catalog: () => send("models/forRole", target),
        save: (patch) => send("models/setRole", { ...target, ...patch, scope }),
      },
      JSON.stringify([apiBase, userId, spaceId, scope, role]),
    );
  }, [apiBase, userId, spaceId, scope, role]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    void controller.load();
  }, [controller, credentials]);
  useEffect(() => {
    if (state.error) AccessibilityInfo.announceForAccessibility(state.error);
  }, [state.error]);
  const settings = state.settings;
  const primary = settings?.primary;
  const rows = primary ? [primary, ...settings.backups] : (settings?.backups ?? []);
  const busy = state.busy || state.stale || !settings;
  const options = connectedBackupOptions(
    state.catalog.filter((entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID),
    credentials,
  );
  const name = (choice: ModelRoleChoice) =>
    options.find((option) => modelRoleChoiceKey(option) === modelRoleChoiceKey(choice))?.label ??
    choice.modelId;
  const changed = async (save: Promise<void>) => {
    await save;
    onChanged?.();
  };
  const pick = (slot: ModelRoleChoice | "primary" | "add") => {
    if (busy) return;
    const pool =
      slot === "add"
        ? options.filter(
            (option) => !rows.some((row) => modelRoleChoiceKey(row) === modelRoleChoiceKey(option)),
          )
        : options;
    const choices = new Map(pool.map((option) => [modelRoleChoiceKey(option), option]));
    const offerDefault = slot === "primary" && role !== "main" && settings.deploymentPrimary;
    openPicker({
      title: slot === "add" ? t("Add fallback") : title,
      selectedKey:
        slot === "primary"
          ? primary
            ? modelRoleChoiceKey(primary)
            : "default"
          : slot === "add"
            ? ""
            : modelRoleChoiceKey(slot),
      choices: [
        ...(offerDefault
          ? [
              {
                key: "default",
                label: name(settings.deploymentPrimary!),
                modelLabel: name(settings.deploymentPrimary!),
              },
            ]
          : []),
        ...pool.map((option) => ({
          key: modelRoleChoiceKey(option),
          label: option.label,
          modelLabel: option.label,
          providerLabel: option.connectionName,
          provider: option.provider,
          modelId: option.modelId,
        })),
      ],
      onSelect: (choice) => {
        if (choice.key === "default") {
          void changed(controller.select("primary", null));
          return;
        }
        const selected = choices.get(choice.key);
        if (selected)
          void changed(
            controller.select(slot, {
              provider: selected.provider,
              modelId: selected.modelId,
              credentialId: selected.credentialId,
            }),
          );
      },
    });
  };
  const levels =
    role === "main" && primary
      ? (
          state.catalog.find(
            (entry) => entry.provider === primary.provider && entry.id === primary.modelId,
          )?.thinkingLevels ?? []
        ).filter((level) => level !== "off")
      : [];
  if (!settings && !state.error) return null;
  return (
    <SettingsGroup accessibilityLabel={title} label={title}>
      {primary || !settings ? null : (
        <SettingsRow
          title={settings.deploymentPrimary ? name(settings.deploymentPrimary) : defaultLabel}
          disabled={busy}
          onPress={() => pick("primary")}
        />
      )}
      {rows.map((choice, index) => {
        const thinking =
          index === 0 && primary && levels.length
            ? [
                {
                  id: "thinking",
                  title: t("Thinking"),
                  subactions: [null, ...levels].map((level) => ({
                    id: `thinking:${level ?? ""}`,
                    title: level ? thinkingLevelLabel(level) : t("Default"),
                    state:
                      level === (choice.thinkingLevel ?? null) ? ("on" as const) : ("off" as const),
                  })),
                },
              ]
            : [];
        const actions: MenuAction[] = [
          ...thinking,
          ...(index > 0 ? [{ id: "up", title: t("Move up") }] : []),
          ...(index < rows.length - 1 ? [{ id: "down", title: t("Move down") }] : []),
          { id: "remove", title: t("Remove"), attributes: { destructive: true } },
        ];
        const act = (action: string) => {
          if (busy) return;
          if (action.startsWith("thinking:"))
            void changed(controller.thinking((action.slice(9) || null) as ThinkingLevel | null));
          else if (action === "remove") void changed(controller.remove(choice));
          else if (action === "up" || action === "down")
            void changed(controller.move(choice, action === "up" ? -1 : 1));
        };
        return (
          <RowMenu
            key={modelRoleChoiceKey(choice)}
            title={name(choice)}
            actions={actions}
            onAction={act}
          >
            <SettingsRow
              title={name(choice)}
              detail={
                primary && index === 0 && choice.thinkingLevel
                  ? thinkingLevelLabel(choice.thinkingLevel)
                  : undefined
              }
              disabled={busy}
              onPress={() => pick(primary && index === 0 ? "primary" : choice)}
              accessibilityRole="button"
              accessibilityActions={actions.flatMap((action) =>
                action.subactions
                  ? action.subactions.map((item) => ({
                      name: item.id!,
                      label: t("Thinking: {level}", { level: item.title }),
                    }))
                  : [{ name: action.id!, label: action.title }],
              )}
              onAccessibilityAction={({ nativeEvent }) => act(nativeEvent.actionName)}
            />
          </RowMenu>
        );
      })}
      {settings && settings.backups.length < MAX_MODEL_BACKUPS ? (
        <SettingsRow title={t("Add fallback")} disabled={busy} onPress={() => pick("add")} />
      ) : null}
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      {state.error ? (
        <SettingsRow
          title={t("Retry")}
          disabled={state.busy}
          onPress={() => void controller.load()}
        />
      ) : null}
    </SettingsGroup>
  );
}
