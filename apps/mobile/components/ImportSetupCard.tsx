import type { AgentImportSetupItem, AgentImportSetupState } from "@rakazo/contracts";
import {
  importSetupStateInput,
  isImportSetupComplete,
  isImportSetupDone,
  isImportSetupVerifiable,
  isRetiredImportSetup,
} from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import type { Href } from "expo-router";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import type { ViewProps } from "react-native";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { ImportSetupBlock } from "../lib/import-setup";
import { importSetupDetail } from "../lib/import-setup";
import { threadCardWidth } from "../lib/message-presentation";
import { native, useMobileTokens } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

const styles = StyleSheet.create({
  card: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, gap: 4 },
  complete: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: typeScale.cardTitle,
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingVertical: 6 },
  text: { flex: 1, minWidth: 0, gap: 1 },
  name: { fontSize: 15 },
  detail: typeScale.secondary,
});

/**
 * What a new bot still needs: routines to turn on and model keys open their native screens;
 * servers and skills are finished on the web.
 */
export function ImportSetupCard({
  botId,
  botName,
  block,
  accessibilityActions,
  onAccessibilityAction,
}: {
  botId: string;
  botName?: string;
  block: ImportSetupBlock;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const readOnly = useThreadReadOnly();
  const tokens = useMobileTokens();
  const { width: windowWidth } = useWindowDimensions();
  const [state, setState] = useState<AgentImportSetupState | null>(null);
  const retired = isRetiredImportSetup(block);

  // Read again on return from a routine or model screen, and when the thread brings a new block.
  useFocusEffect(
    useCallback(() => {
      if (retired) return;
      let current = true;
      rpc("bots/importSetupState", importSetupStateInput(botId, block))
        .then((next) => {
          if (current) setState(next);
        })
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [botId, block, retired]),
  );

  if (retired) return null;
  const cardStyle = [
    styles.card,
    { width: threadCardWidth(windowWidth), backgroundColor: native.fill },
  ];

  if (isImportSetupComplete(block, state)) {
    return (
      <View testID="import-setup-card" style={[cardStyle, styles.complete]}>
        <NativeSymbol
          ios="checkmark.circle.fill"
          android="checkmark-circle"
          size={18}
          color={tokens.success}
        />
        <Text
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={onAccessibilityAction}
          style={[styles.name, { color: tokens.foreground }]}
        >
          {t("Setup complete")}
        </Text>
      </View>
    );
  }

  function target(item: AgentImportSetupItem): Href | null {
    if (item.kind === "model") return "/models";
    if (item.kind === "routine")
      return {
        pathname: "/routine",
        params: { botId, botName, routineId: item.routineId, origin: "profile" },
      };
    return null;
  }

  return (
    <View testID="import-setup-card" style={cardStyle}>
      <Text
        accessibilityRole="header"
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        style={[styles.title, { color: tokens.foreground }]}
      >
        {t("Finish setting up")}
      </Text>
      {block.items.map((item, index) => {
        const name = item.kind === "model" ? item.title : item.name;
        const done = isImportSetupDone(item, state);
        const href = readOnly ? null : target(item);
        const detail = [
          importSetupDetail(item),
          isImportSetupVerifiable(item) ? "" : t("Check this yourself"),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <View key={`${index}:${name}`} style={styles.row}>
            <View style={styles.text}>
              <Text numberOfLines={1} style={[styles.name, { color: tokens.foreground }]}>
                {name}
              </Text>
              {detail ? (
                <Text style={[styles.detail, { color: tokens.mutedForeground }]}>{detail}</Text>
              ) : null}
            </View>
            {done ? (
              <View accessible accessibilityLabel={t("Done")}>
                <NativeSymbol
                  ios="checkmark"
                  android="checkmark"
                  size={16}
                  color={tokens.success}
                />
              </View>
            ) : href ? (
              <NativeActionButton
                label={t("Open")}
                accessibilityLabel={t("Open {name}", { name })}
                fill={false}
                prominence="secondary"
                size="compact"
                onPress={() => router.push(href)}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
