import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import type { ViewProps } from "react-native";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { threadCardWidth } from "../lib/message-presentation";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useThreadReadOnly } from "../lib/thread-read-only";
import { NativeActionButton } from "./native-action-button";

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  header: { flexDirection: "row", gap: 8, justifyContent: "space-between" },
  state: { flexShrink: 1, fontSize: 13 },
  title: { fontSize: 15, fontWeight: "600" },
});

export function ComputerCard({
  block,
  onOpen,
  accessibilityActions,
  onAccessibilityAction,
}: {
  block: Extract<MessageBlock, { kind: "computer" }>;
  onOpen?: () => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const readOnly = useThreadReadOnly();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { width: windowWidth } = useWindowDimensions();

  return (
    <View
      testID="computer-card"
      style={[
        styles.card,
        {
          width: threadCardWidth(windowWidth),
          backgroundColor: native.fill,
        },
      ]}
    >
      <View style={styles.header}>
        <Text
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={onAccessibilityAction}
          style={[styles.title, { color: tokens.foreground }]}
        >
          {t("Computer")}
        </Text>
        <Text
          style={[
            styles.state,
            { color: block.state === "Needs you" ? tokens.warning : tokens.success },
          ]}
        >
          {block.state}
        </Text>
      </View>
      {block.text ? (
        <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
          {block.text}
        </ChatMarkdown>
      ) : null}
      {onOpen && !readOnly ? (
        <View testID="computer-card-open">
          <NativeActionButton label={t("Open computer")} fill={false} onPress={onOpen} />
        </View>
      ) : null}
    </View>
  );
}
