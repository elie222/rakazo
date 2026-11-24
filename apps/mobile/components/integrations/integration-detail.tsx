import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Connection, ConnectionCatalogItem, RpcOutput } from "@rakazo/contracts";
import { CONNECTION_LABEL_MAX_LENGTH } from "@rakazo/contracts";
import { catalogItemKey } from "@rakazo/core";
import type { Dispatch, SetStateAction } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { native, useThemedStyles } from "../../lib/native/native";
import { NativeActionButton } from "../native/native-action-button";
import { ConnectorIcon } from "./connector-icon";
import { createIntegrationsStyles, LOGO_SIZE } from "./integrations-styles";
import { ToolPermissions } from "./tool-permissions";

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
  toolsFailed,
  onBack,
  onUninstall,
  onRename,
  onRevoke,
  onConnect,
  onOpenChatApp,
}: {
  item: ConnectionCatalogItem;
  accounts: Connection[];
  pending: string | null;
  labelDrafts: Record<string, string>;
  setLabelDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  tools: ConnectionTool[];
  toolsLoading: boolean;
  toolsFailed: boolean;
  onBack: () => void;
  onUninstall: () => void;
  onRename: (row: Connection) => void;
  onRevoke: (row: Connection) => void;
  onConnect: () => void;
  onOpenChatApp: () => void;
}) {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useLingui();
  const key = catalogItemKey(item);
  const connecting = pending === key;
  const uninstalling = pending === `uninstall:${key}`;

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
        <NativeActionButton
          accessibilityLabel={t`Add another ${ph({ name: item.name })}`}
          disabled={connecting || uninstalling}
          label={connecting ? t`Working…` : t`Add another`}
          onPress={onConnect}
          prominence="secondary"
        />
      </View>

      {toolsFailed ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {t`Could not load permissions`}
        </Text>
      ) : toolsLoading ? (
        <ActivityIndicator
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t`Loading tool permissions…`}
          color={native.secondaryLabel}
        />
      ) : tools.length > 0 ? (
        <ToolPermissions tools={tools} slug={item.slug} />
      ) : null}
      {item.chatApp ? (
        <Text accessibilityRole="link" onPress={onOpenChatApp} style={styles.inlineLink}>
          {t`Chat from ${ph({ name: item.name })}`}
        </Text>
      ) : null}
    </View>
  );
}
