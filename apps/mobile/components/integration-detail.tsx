import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Connection, ConnectionCatalogItem, RpcOutput } from "@rakazo/contracts";
import { CONNECTION_LABEL_MAX_LENGTH } from "@rakazo/contracts";
import { catalogItemKey, humanizeToolName } from "@rakazo/core";
import type { Dispatch, SetStateAction } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { native, useThemedStyles } from "../lib/native";
import { ConnectorIcon } from "./connector-icon";
import { createIntegrationsStyles, LOGO_SIZE } from "./integrations-styles";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { Chevron } from "./row-accessories";

export type ConnectionTool = RpcOutput<"connections/tools">[number];

/** One connected app: its accounts, their labels, and the tools it gives bots. */
export function IntegrationDetail({
  item,
  accounts,
  pending,
  labelDrafts,
  setLabelDrafts,
  tools,
  toolsLoading,
  toolsOpen,
  setToolsOpen,
  onBack,
  onUninstall,
  onRename,
  onRevoke,
  onSetDefault,
  onConnect,
}: {
  item: ConnectionCatalogItem;
  accounts: Connection[];
  pending: string | null;
  labelDrafts: Record<string, string>;
  setLabelDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  tools: ConnectionTool[];
  toolsLoading: boolean;
  toolsOpen: boolean;
  setToolsOpen: Dispatch<SetStateAction<boolean>>;
  onBack: () => void;
  onUninstall: () => void;
  onRename: (row: Connection) => void;
  onRevoke: (row: Connection) => void;
  onSetDefault: (row: Connection) => void;
  onConnect: () => void;
}) {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useLingui();
  const key = catalogItemKey(item);
  const connecting = pending === key;
  const uninstalling = pending === `uninstall:${key}`;
  const toolCount = tools.length;
  const connected = accounts.filter((row) => row.status === "connected");
  const defaultAccount = connected.find((row) => row.isDefault);

  return (
    <View style={styles.detail}>
      <View style={styles.detailHeader}>
        <View style={styles.detailTitleRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t`Back`}
            onPress={onBack}
            style={styles.backButton}
          >
            <Text style={styles.link}>{t`Back`}</Text>
          </Pressable>
          <ConnectorIcon logo={item.logo} name={item.name} size={LOGO_SIZE} />
          <Text numberOfLines={1} style={styles.detailTitle}>
            {item.name}
          </Text>
        </View>
        <NativeActionButton
          accessibilityLabel={t`Uninstall`}
          disabled={uninstalling || connecting}
          fill={false}
          label={uninstalling ? t`Working…` : t`Uninstall`}
          onPress={onUninstall}
          prominence="destructive"
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>{t`Accounts`}</Text>
        {accounts.map((row) => (
          <View key={row.id} style={styles.accountRow}>
            <TextInput
              value={labelDrafts[row.id] ?? row.displayName}
              maxLength={CONNECTION_LABEL_MAX_LENGTH}
              onChangeText={(value) =>
                setLabelDrafts((current) => ({ ...current, [row.id]: value }))
              }
              onEndEditing={() => onRename(row)}
              accessibilityLabel={t`Account label`}
              style={styles.accountLabel}
            />
            <NativeActionButton
              accessibilityLabel={t`Remove ${ph({ name: row.displayName })}`}
              disabled={pending === row.id || uninstalling}
              fill={false}
              label={pending === row.id ? t`Working…` : t`Remove`}
              onPress={() => onRevoke(row)}
              prominence="destructive"
            />
          </View>
        ))}
        {connected.length > 1 ? (
          <MenuPicker
            label={t`Default account`}
            plain
            choices={connected.map((row) => ({ key: row.id, label: row.displayName }))}
            value={defaultAccount?.id ?? ""}
            onChange={(id) => {
              const row = connected.find((entry) => entry.id === id);
              if (row && !row.isDefault) onSetDefault(row);
            }}
          />
        ) : null}
        <NativeActionButton
          accessibilityLabel={t`Add another ${ph({ name: item.name })}`}
          disabled={connecting || uninstalling}
          label={connecting ? t`Working…` : t`Add another`}
          onPress={onConnect}
          prominence="secondary"
        />
      </View>

      <View style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: toolsOpen }}
          onPress={() => setToolsOpen((open) => !open)}
          style={styles.toolsToggle}
        >
          <Text style={styles.title}>
            {toolsLoading
              ? t`Tools`
              : toolCount === 1
                ? t`1 tool`
                : t`${ph({ count: toolCount })} tools`}
          </Text>
          <Chevron expanded={toolsOpen} />
        </Pressable>
        {toolsOpen ? (
          <View style={styles.toolsBody}>
            {toolsLoading ? (
              <ActivityIndicator
                color={native.secondaryLabel}
                accessibilityLabel={t`Loading tools…`}
              />
            ) : tools.length === 0 ? (
              <Text style={styles.secondary}>{t`No tools available.`}</Text>
            ) : (
              tools.map((tool) => (
                <Text key={tool.name} style={styles.toolName}>
                  {humanizeToolName(tool.name)}
                </Text>
              ))
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}
