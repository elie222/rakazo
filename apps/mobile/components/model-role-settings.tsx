import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type {
  ModelCatalogEntry,
  ModelCredential,
  ModelRole,
  ModelRoleChoice,
  RpcInput,
  RpcPath,
  ModelRoleSettings as Settings,
  SettingsScope,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  backupChoiceKey,
  canonicalPiProviderId,
  connectedBackupOptions,
  connectionDisplayName,
  MAX_MODEL_BACKUPS,
  modelRoleChoiceKey,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  withConnectionName,
} from "@rakazo/contracts";
import { createModelRoleSettings, modelRoleListPatch } from "@rakazo/core";
import type { Href } from "expo-router";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, StyleSheet, Text, View } from "react-native";
import type { RpcArgs } from "../lib/api";
import { captureApiRequestContext, currentApiBase, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import type { ModelPickerRequest } from "../lib/model-picker-selection";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { thinkingLevelLabel } from "../lib/thinking-level";
import { SettingsGroup, SettingsRow } from "./settings-group";

export type ConnectableProvider = { id: string; name: string; baseUrl?: string };

export type ModelConnectIntent = {
  /** Only the main model's empty first slot takes the new connection's model on connect. */
  makeDefault: boolean;
  /** Returns the picker to continue in, narrowed to the new connection. */
  onConnected: (choice: ModelRoleChoice) => Promise<Href | undefined>;
};

/** A row index, the empty first slot, or a new fallback at the end. */
type Slot = number | "empty" | "add";

/** The same model on another connection is another row. */
const sameChoice = (left: ModelRoleChoice, right: ModelRoleChoice) =>
  modelRoleChoiceKey(left) === modelRoleChoiceKey(right);

const connectKey = (provider: ConnectableProvider) =>
  `connect:${provider.id}:${provider.baseUrl ?? ""}`;

/** One ordered list per model purpose: the first row runs, the rest take over in order. */
export function ModelRoleSettings({
  userId,
  spaceId,
  scope,
  modelRole: role,
  credentials,
  title,
  defaultLabel,
  providers,
  openPicker,
  pickerRoute,
  connectRoute,
  onManage,
  onChanged,
}: {
  userId: string;
  /** The Space the calls go to; a Space scope edits its override. */
  spaceId: string;
  scope: SettingsScope;
  modelRole: ModelRole;
  credentials: ModelCredential[];
  title: string;
  /** What runs when the first slot is empty. */
  defaultLabel: string;
  /** Providers without a connection, offered at the end of the picker. */
  providers: ConnectableProvider[];
  openPicker: (request: ModelPickerRequest) => void;
  /** Registers a picker that continues from another screen and returns its route. */
  pickerRoute: (request: ModelPickerRequest) => Href;
  /** Registers a connect flow and returns the screen that runs it. */
  connectRoute: (provider: ConnectableProvider, intent: ModelConnectIntent) => Href;
  /** Opens one connection's screen. */
  onManage: (credential: ModelCredential) => void;
  /** The main model's first slot is the space default, which other settings read. */
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const apiBase = currentApiBase();
  const { controller, send } = useMemo(() => {
    const requestContext = captureApiRequestContext(spaceId);
    const send = async <P extends RpcPath>(proc: P, input: RpcInput<P>) =>
      rpc(proc, ...([input, { requestContext: await requestContext }] as RpcArgs<P>));
    const target = { role, expectedUserId: userId };
    return {
      send,
      controller: createModelRoleSettings(
        {
          load: () => send("models/role", { ...target, scope }),
          catalog: () => send("models/forRole", target),
          save: (patch) => send("models/setRole", { ...target, ...patch, scope }),
        },
        JSON.stringify([apiBase, userId, spaceId, scope, role]),
      ),
    };
  }, [apiBase, userId, spaceId, scope, role]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    void controller.load();
  }, [controller, credentials]);
  const error = state.error;
  useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);

  const settings = state.settings;
  const primary = settings?.primary ?? null;
  const backups = settings?.backups ?? [];
  const rows = primary ? [primary, ...backups] : backups;
  const busy = state.busy || state.stale || !settings;
  const entryFor = (choice: ModelRoleChoice) =>
    state.catalog.find(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(choice.provider) &&
        entry.id === choice.modelId,
    );
  const options = connectedBackupOptions(state.catalog, credentials);
  const optionFor = (choice: ModelRoleChoice) =>
    options.find((option) => backupChoiceKey(option) === backupChoiceKey(choice));
  const modelLabel = (choice: ModelRoleChoice) =>
    entryFor(choice)?.label ?? optionFor(choice)?.label ?? choice.modelId;
  const providerName = (choice: ModelRoleChoice) =>
    entryFor(choice)?.providerName ??
    optionFor(choice)?.providerName ??
    providers.find((provider) => provider.id === choice.provider)?.name ??
    choice.provider;
  // What runs when the member chose no first model; named in the empty row.
  const deployment = state.settings?.deploymentPrimary ?? null;
  const deploymentName = deployment ? modelLabel(deployment) : null;
  /** The row's own connection, or the provider's newest for rows that name none. */
  const connectionFor = (choice: ModelRoleChoice) =>
    choice.credentialId
      ? credentials.find((entry) => entry.id === choice.credentialId)
      : credentials.find(
          (entry) =>
            canonicalPiProviderId(entry.provider) === canonicalPiProviderId(choice.provider),
        );
  const connectionName = (choice: ModelRoleChoice) => {
    const connection = choice.credentialId ? connectionFor(choice) : undefined;
    return connection
      ? connectionDisplayName(connection, providerName(choice))
      : providerName(choice);
  };
  const isPrimarySlot = (slot: Slot) => slot === "empty" || (slot === 0 && primary !== null);

  // Compatible endpoints keep their effort with the connection.
  const thinkingLevels =
    role === "main" && primary && primary.provider !== OPENAI_COMPATIBLE_PROVIDER_ID
      ? (entryFor(primary)?.thinkingLevels ?? []).filter((level) => level !== "off")
      : [];
  const thinking = primary?.thinkingLevel ?? null;

  async function save(update: (current: Settings) => Partial<Settings>) {
    let primaryChanged = false;
    await controller.save((current) => {
      const patch = update(current);
      primaryChanged = "primary" in patch;
      return patch;
    });
    if (role === "main" && primaryChanged) onChanged?.();
  }
  const setPrimary = (choice: ModelRoleChoice | null) =>
    save((current) => ({
      primary: choice,
      backups: choice
        ? current.backups.filter((item) => !sameChoice(item, choice))
        : current.backups,
    }));
  const place = (slot: number | "add", choice: ModelRoleChoice) =>
    save((current) => {
      const list = current.primary ? [current.primary, ...current.backups] : current.backups;
      if (slot === "add")
        return modelRoleListPatch(current, [
          ...list.filter((item) => !sameChoice(item, choice)),
          choice,
        ]);
      return modelRoleListPatch(
        current,
        list
          .map((item, index) => (index === slot ? choice : item))
          .filter((item, index) => index === slot || !sameChoice(item, choice)),
      );
    });
  // The first entry becomes the primary; with none, the deployment's default runs.
  const commit = (next: ModelRoleChoice[]) => save((current) => modelRoleListPatch(current, next));
  const fill = (slot: Slot, choice: ModelRoleChoice) =>
    slot === "empty" || isPrimarySlot(slot) ? setPrimary(choice) : place(slot, choice);

  const setThinking = (level: ThinkingLevel | null) =>
    save((current) => ({
      primary: current.primary && { ...current.primary, thinkingLevel: level },
    }));

  /** After a connection, the same slot's picker shows only that connection's models. */
  type Narrowed = {
    choice: ModelRoleChoice;
    credentials: ModelCredential[];
    /** Loaded after the connection, so account-specific models it unlocks are listed. */
    catalog: ModelCatalogEntry[];
    selected: boolean;
  };

  function pickerRequest(slot: Slot, narrowed?: Narrowed): ModelPickerRequest {
    const primarySlot = isPrimarySlot(slot);
    const all = narrowed ? connectedBackupOptions(narrowed.catalog, narrowed.credentials) : options;
    const pool = all.filter(
      (option) => !narrowed || option.credentialId === narrowed.choice.credentialId,
    );
    const current = narrowed
      ? narrowed.selected
        ? narrowed.choice
        : undefined
      : typeof slot === "number"
        ? rows[slot]
        : undefined;
    // A row that names no connection runs on its provider's, so its model is taken too.
    const taken = new Set(
      rows.map((row) => (row.credentialId ? modelRoleChoiceKey(row) : backupChoiceKey(row))),
    );
    const offerDefault = primarySlot && role !== "main" && !narrowed && deployment !== null;
    // A row that names no connection is checked on its provider's first connection.
    const currentKey = current
      ? modelRoleChoiceKey(
          current.credentialId
            ? current
            : (pool.find((option) => backupChoiceKey(option) === backupChoiceKey(current)) ??
                current),
        )
      : undefined;
    const picks = new Map(pool.map((option) => [modelRoleChoiceKey(option), option]));
    return {
      title: slot === "add" ? t("Add fallback") : title,
      selectedKey: currentKey ?? (offerDefault ? "default" : ""),
      choices: [
        ...(offerDefault
          ? [
              {
                key: "default",
                label: deploymentName ?? defaultLabel,
                modelLabel: deploymentName ?? defaultLabel,
              },
            ]
          : []),
        ...pool
          .filter(
            (option) =>
              slot !== "add" ||
              !(taken.has(modelRoleChoiceKey(option)) || taken.has(backupChoiceKey(option))),
          )
          .map((option) => ({
            key: modelRoleChoiceKey(option),
            label: withConnectionName(option.label, option.connectionName),
            modelLabel: option.label,
            providerLabel: option.connectionName,
            provider: option.provider,
            modelId: option.modelId,
          })),
      ],
      connectChoices: narrowed
        ? undefined
        : providers.map((provider) => ({
            key: connectKey(provider),
            label: provider.name,
            modelLabel: provider.name,
          })),
      continueTo: (choice) => {
        const provider = providers.find((entry) => connectKey(entry) === choice.key);
        if (!provider) return undefined;
        // Only the main model's empty first slot takes the connection itself as its model.
        const makeDefault = role === "main" && slot === "empty";
        return connectRoute(provider, {
          makeDefault,
          onConnected: async (connected) => {
            const [fresh] = await Promise.all([send("models/credentials", {}), controller.load()]);
            const next = pickerRequest(slot, {
              choice: connected,
              credentials: fresh,
              catalog: controller.snapshot().catalog,
              selected: makeDefault,
            });
            return next.choices.length ? pickerRoute(next) : undefined;
          },
        });
      },
      onSelect: (choice) => {
        if (choice.key === "default") {
          void setPrimary(null);
          return;
        }
        const option = picks.get(choice.key);
        if (!option) return;
        const picked: ModelRoleChoice = {
          provider: option.provider,
          modelId: option.modelId,
          ...(option.credentialId ? { credentialId: option.credentialId } : {}),
        };
        if (!current || !sameChoice(current, picked)) void fill(slot, picked);
      },
    };
  }

  function pick(slot: Slot) {
    if (!busy) openPicker(pickerRequest(slot));
  }

  function act(index: number, id: string) {
    if (busy) return;
    const choice = rows[index];
    if (!choice) return;
    if (id.startsWith("thinking:")) {
      void setThinking((id.slice("thinking:".length) || null) as ThinkingLevel | null);
    } else if (id === "moveUp" || id === "moveDown") {
      const target = index + (id === "moveUp" ? -1 : 1);
      if (target < 0 || target >= rows.length) return;
      const next = [...rows];
      next.splice(target, 0, ...next.splice(index, 1));
      void commit(next);
    } else if (id === "manage") {
      const connection = connectionFor(choice);
      if (connection) onManage(connection);
    } else if (id === "remove") {
      void commit(rows.filter((_, item) => item !== index));
    }
  }

  if (!settings && !state.error) return null;
  const offset = primary ? 0 : 1;
  // Order only means something once there is more than one row.
  const ordered = rows.length + offset > 1;
  const number = (index: number) => (
    <Text style={styles.number} accessibilityElementsHidden importantForAccessibility="no">
      {index + 1}
    </Text>
  );
  return (
    <SettingsGroup accessibilityLabel={title} label={title}>
      {primary || !settings ? null : (
        <SettingsRow
          key="empty"
          leading={ordered ? number(0) : undefined}
          title={deploymentName ?? defaultLabel}
          detail={deployment ? providerName(deployment) : undefined}
          disabled={busy}
          onPress={() => pick("empty")}
        />
      )}
      {rows.map((choice, index) => {
        const name = modelLabel(choice);
        const showThinking = role === "main" && index === 0 && primary !== null;
        const thinkingMenu: MenuAction[] =
          showThinking && thinkingLevels.length
            ? [
                {
                  id: "thinking",
                  title: t("Thinking"),
                  subactions: [null, ...thinkingLevels].map((level) => ({
                    // MenuView reports an empty id as the title, so keep a prefix.
                    id: `thinking:${level ?? ""}`,
                    title: level ? thinkingLevelLabel(level, t) : t("Default"),
                    state: level === thinking ? "on" : "off",
                  })),
                },
              ]
            : [];
        const actions: MenuAction[] = [
          ...thinkingMenu,
          ...(index > 0 ? [{ id: "moveUp", title: t("Move up") }] : []),
          ...(index < rows.length - 1 ? [{ id: "moveDown", title: t("Move down") }] : []),
          ...(connectionFor(choice)
            ? [
                {
                  id: "manage",
                  title: t("Manage {provider}", { provider: connectionName(choice) }),
                },
              ]
            : []),
          { id: "remove", title: t("Remove"), attributes: { destructive: true } },
        ];
        const accessibilityActions = actions.flatMap((action) =>
          action.subactions
            ? action.subactions.map((sub) => ({
                name: sub.id ?? sub.title,
                label: t("Thinking: {level}", { level: sub.title }),
              }))
            : action.attributes?.disabled
              ? []
              : [{ name: action.id ?? action.title, label: action.title }],
        );
        const detail = [
          connectionName(choice),
          ...(showThinking && thinking
            ? [t("Thinking: {level}", { level: thinkingLevelLabel(thinking, t) })]
            : []),
        ].join(", ");
        return (
          <RowMenu
            key={modelRoleChoiceKey(choice)}
            title={name}
            actions={actions}
            onAction={(id) => act(index, id)}
          >
            <SettingsRow
              accessibilityRole="button"
              leading={ordered ? number(index + offset) : undefined}
              title={name}
              detail={detail}
              disabled={busy}
              onPress={() => pick(index)}
              accessibilityActions={accessibilityActions}
              onAccessibilityAction={({ nativeEvent }) => act(index, nativeEvent.actionName)}
            />
          </RowMenu>
        );
      })}
      {settings && backups.length < MAX_MODEL_BACKUPS ? (
        <SettingsRow
          key="add"
          title={t("Add fallback")}
          disabled={busy}
          onPress={() => pick("add")}
        />
      ) : null}
      {error ? (
        <Text key="error" accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {state.error ? (
        <SettingsRow
          key="retry"
          title={t("Retry")}
          disabled={state.busy}
          onPress={() => void controller.load()}
        />
      ) : null}
    </SettingsGroup>
  );
}

/** A long-press native menu around a full-width row. */
export function RowMenu({
  title,
  actions,
  onAction,
  children,
}: {
  title: string;
  actions: MenuAction[];
  onAction: (id: string) => void;
  children: ReactNode;
}) {
  const colorScheme = useResolvedAppearance();
  // Native menu hosts size to their contents, so measure outside the host.
  const [width, setWidth] = useState<number>();
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={rowMenuStyles.fullWidth}
    >
      <MenuView
        shouldOpenOnLongPress
        colorScheme={colorScheme}
        title={title}
        actions={actions}
        onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
        style={rowMenuStyles.fullWidth}
      >
        <View style={{ width }}>{children}</View>
      </MenuView>
    </View>
  );
}

const rowMenuStyles = StyleSheet.create({ fullWidth: { width: "100%" } });

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    number: {
      minWidth: 16,
      color: native.secondaryLabel,
      fontSize: 15,
      fontVariant: ["tabular-nums"],
    },
    error: {
      color: tokens.destructive,
      fontSize: 15,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
  });
}
