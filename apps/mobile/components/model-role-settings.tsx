import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type {
  ModelBackupChoice,
  ModelCatalogEntry,
  ModelCredential,
  ModelRole,
  ModelRoleSettings as Settings,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  backupChoiceKey,
  canonicalPiProviderId,
  connectedBackupOptions,
  MAX_MODEL_BACKUPS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { createModelRoleSettings } from "@rakazo/core";
import type { Href } from "expo-router";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, StyleSheet, Text, View } from "react-native";
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
  /** Returns the picker to continue in, narrowed to the newly connected provider. */
  onConnected: (choice: ModelBackupChoice) => Promise<Href | undefined>;
};

/** A row index, the empty first slot, or a new fallback at the end. */
type Slot = number | "empty" | "add";

const sameChoice = (left: ModelBackupChoice, right: ModelBackupChoice) =>
  backupChoiceKey(left) === backupChoiceKey(right);

const connectKey = (provider: ConnectableProvider) =>
  `connect:${provider.id}:${provider.baseUrl ?? ""}`;

/** Sends the first slot only when it changes. */
function listPatch(current: Settings, list: ModelBackupChoice[]): Partial<Settings> {
  if (!current.primary) return { backups: list };
  const primary = list[0] ?? null;
  return primary && sameChoice(primary, current.primary)
    ? { backups: list.slice(1) }
    : { primary, backups: list.slice(1) };
}

/** One ordered list per model purpose: the first row runs, the rest take over in order. */
export function ModelRoleSettings({
  userId,
  spaceId,
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
  spaceId: string;
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
  onManage: (provider: string) => void;
  /** The main model's first slot is the space default, which other settings read. */
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const apiBase = currentApiBase();
  const { controller, send } = useMemo(() => {
    const requestContext = captureApiRequestContext().then((context) => ({
      ...context,
      headers: { ...context.headers, "x-rakazo-space-id": spaceId },
    }));
    const send = async <T,>(proc: string, input: object) =>
      rpc<T>(proc, input, { requestContext: await requestContext });
    const call = <T,>(proc: string, patch = {}) =>
      send<T>(proc, { role, expectedUserId: userId, ...patch });
    return {
      send,
      controller: createModelRoleSettings(
        {
          load: () => call<Settings>("models/role"),
          catalog: () => call("models/forRole"),
          save: (patch) => call<Settings>("models/setRole", patch),
        },
        JSON.stringify([apiBase, userId, spaceId, role]),
      ),
    };
  }, [apiBase, userId, spaceId, role]);
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
  const entryFor = (choice: ModelBackupChoice) =>
    state.catalog.find(
      (entry) =>
        canonicalPiProviderId(entry.provider) === canonicalPiProviderId(choice.provider) &&
        entry.id === choice.modelId,
    );
  const connected = new Set(credentials.map((entry) => canonicalPiProviderId(entry.provider)));
  const options = connectedBackupOptions(state.catalog, credentials);
  const optionFor = (choice: ModelBackupChoice) =>
    options.find((option) => sameChoice(option, choice));
  const modelLabel = (choice: ModelBackupChoice) =>
    entryFor(choice)?.label ?? optionFor(choice)?.label ?? choice.modelId;
  const providerName = (choice: ModelBackupChoice) =>
    entryFor(choice)?.providerName ??
    optionFor(choice)?.providerName ??
    providers.find((provider) => provider.id === choice.provider)?.name ??
    choice.provider;
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
  const setPrimary = (choice: ModelBackupChoice | null) =>
    save((current) => ({
      primary: choice,
      backups: choice
        ? current.backups.filter((item) => !sameChoice(item, choice))
        : current.backups,
    }));
  const place = (slot: number | "add", choice: ModelBackupChoice) =>
    save((current) => {
      const list = current.primary ? [current.primary, ...current.backups] : current.backups;
      if (slot === "add")
        return listPatch(current, [...list.filter((item) => !sameChoice(item, choice)), choice]);
      return listPatch(
        current,
        list
          .map((item, index) => (index === slot ? choice : item))
          .filter((item, index) => index === slot || !sameChoice(item, choice)),
      );
    });
  // The first entry becomes the primary; with none, the deployment's default runs.
  const commit = (next: ModelBackupChoice[]) => save((current) => listPatch(current, next));
  const fill = (slot: Slot, choice: ModelBackupChoice) =>
    slot === "empty" || isPrimarySlot(slot) ? setPrimary(choice) : place(slot, choice);

  const setThinking = (level: ThinkingLevel | null) =>
    save((current) => ({
      primary: current.primary && { ...current.primary, thinkingLevel: level },
    }));

  /** After a connection, the same slot's picker shows only that provider's models. */
  type Narrowed = {
    provider: string;
    credentials: ModelCredential[];
    /** Loaded after the connection, so account-specific models it unlocks are listed. */
    catalog: ModelCatalogEntry[];
    selected?: ModelBackupChoice;
  };

  function pickerRequest(slot: Slot, narrowed?: Narrowed): ModelPickerRequest {
    const primarySlot = isPrimarySlot(slot);
    const all = narrowed ? connectedBackupOptions(narrowed.catalog, narrowed.credentials) : options;
    const pool = all.filter(
      (option) =>
        !narrowed ||
        canonicalPiProviderId(option.provider) === canonicalPiProviderId(narrowed.provider),
    );
    const current = narrowed?.selected ?? (typeof slot === "number" ? rows[slot] : undefined);
    const taken = new Set(rows.map(backupChoiceKey));
    const offerDefault = primarySlot && role !== "main" && !narrowed;
    return {
      title: slot === "add" ? t("Add fallback") : title,
      selectedKey: current ? backupChoiceKey(current) : offerDefault ? "default" : "",
      choices: [
        ...(offerDefault
          ? [{ key: "default", label: defaultLabel, modelLabel: defaultLabel }]
          : []),
        ...pool
          .filter((option) => slot !== "add" || !taken.has(backupChoiceKey(option)))
          .map((option) => ({
            key: backupChoiceKey(option),
            label: `${option.providerName} · ${option.label}`,
            modelLabel: option.label,
            providerLabel: option.providerName,
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
            const [fresh] = await Promise.all([
              send<ModelCredential[]>("models/credentials", {}),
              controller.load(),
            ]);
            const next = pickerRequest(slot, {
              provider: connected.provider,
              credentials: fresh,
              catalog: controller.snapshot().catalog,
              selected: makeDefault ? connected : undefined,
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
        if (!choice.provider || !choice.modelId) return;
        const picked = { provider: choice.provider, modelId: choice.modelId };
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
      onManage(choice.provider);
    } else if (id === "remove") {
      void commit(rows.filter((_, item) => item !== index));
    }
  }

  if (!settings && !state.error) return null;
  const offset = primary ? 0 : 1;
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
          leading={number(0)}
          title={defaultLabel}
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
          ...(connected.has(canonicalPiProviderId(choice.provider))
            ? [{ id: "manage", title: t("Manage {provider}", { provider: providerName(choice) }) }]
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
          providerName(choice),
          ...(showThinking && thinking
            ? [t("Thinking: {level}", { level: thinkingLevelLabel(thinking, t) })]
            : []),
        ].join(" · ");
        return (
          <RowMenu
            key={backupChoiceKey(choice)}
            title={name}
            actions={actions}
            onAction={(id) => act(index, id)}
          >
            <SettingsRow
              accessibilityRole="button"
              leading={number(index + offset)}
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
function RowMenu({
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
