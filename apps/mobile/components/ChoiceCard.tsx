import type { MessageBlock } from "@rakazo/contracts";
import { useRef, useState } from "react";
import type { ViewProps } from "react-native";
import { Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import {
  choiceCardOptions,
  DISMISSED_CHOICE_ANSWER_ID,
  threadCardWidth,
} from "../lib/message-presentation";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeSymbol } from "./native-symbol";

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  dismiss: { alignItems: "center", height: 24, justifyContent: "center", width: 24 },
  header: { alignItems: "flex-start", flexDirection: "row", gap: 8 },
  heading: { flex: 1, gap: 2 },
  letter: {
    alignItems: "center",
    borderRadius: 7,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
  letterText: { fontSize: 12.5, fontWeight: "500" },
  option: {
    alignItems: "center",
    borderRadius: 12,
    flexDirection: "row",
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  optionLabel: { flex: 1, fontSize: 15 },
  options: { gap: 8 },
  question: { fontSize: 15.5 },
  subtitle: { fontSize: 13 },
});

export function ChoiceCard({
  botId,
  block,
  onDismissed,
  accessibilityActions,
  onAccessibilityAction,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "choice" }>;
  onDismissed?: () => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { width: windowWidth } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  // Set in the handler, so a second tap cannot pass before the buttons re-render disabled.
  const pending = useRef(false);
  // Shows the outcome before the thread stream delivers the updated block.
  const [localAnswerId, setLocalAnswerId] = useState<string>();
  const answerId = block.answerId ?? localAnswerId;
  if (answerId === DISMISSED_CHOICE_ANSWER_ID) return null;

  // Dismissing records the server's dismissed answer id, so both outcomes share this path.
  async function submit(optionId: string) {
    if (pending.current || answerId) return;
    pending.current = true;
    setBusy(true);
    try {
      if (optionId === DISMISSED_CHOICE_ANSWER_ID) {
        await rpc("onboarding/dismissFocus", { botId });
      } else {
        await rpc("onboarding/choose", { botId, optionId });
      }
      setLocalAnswerId(optionId);
      if (optionId === DISMISSED_CHOICE_ANSWER_ID) onDismissed?.();
    } catch (reason) {
      Alert.alert(t("Could not complete action"), errorText(reason, t("Please try again.")));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <View
      testID="choice-card"
      style={[
        styles.card,
        {
          width: threadCardWidth(windowWidth),
          backgroundColor: native.fill,
        },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text
            accessibilityRole="header"
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            style={[styles.question, { color: tokens.foreground }]}
          >
            {block.question}
          </Text>
          {block.subtitle ? (
            <Text style={[styles.subtitle, { color: tokens.mutedForeground }]}>
              {block.subtitle}
            </Text>
          ) : null}
        </View>
        {!answerId ? (
          <Pressable
            testID="choice-card-dismiss"
            accessibilityRole="button"
            accessibilityLabel={t("Dismiss")}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            hitSlop={10}
            onPress={() => void submit(DISMISSED_CHOICE_ANSWER_ID)}
            style={styles.dismiss}
          >
            <NativeSymbol ios="xmark" android="close" size={14} color={tokens.mutedForeground} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.options}>
        {choiceCardOptions({ ...block, answerId }).map((option) => {
          const chosen = option.id === answerId;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ disabled: busy || chosen, selected: chosen }}
              disabled={busy || chosen}
              onPress={() => void submit(option.id)}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: pressed || chosen ? native.fillPressed : native.page,
                  opacity: busy ? 0.6 : 1,
                },
              ]}
            >
              <View style={[styles.letter, { backgroundColor: native.fill }]}>
                <Text style={[styles.letterText, { color: tokens.mutedForeground }]}>
                  {option.letter}
                </Text>
              </View>
              <Text
                style={[
                  styles.optionLabel,
                  { color: chosen ? tokens.mutedForeground : tokens.foreground },
                ]}
              >
                {option.label}
              </Text>
              {chosen ? (
                <NativeSymbol
                  ios="checkmark"
                  android="checkmark"
                  size={15}
                  color={tokens.mutedForeground}
                />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
