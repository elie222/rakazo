import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";

type AskAction = { id: string; label: string };

const KNOWN_ASK_ACTION_LABELS: Record<string, string> = {
  allow: "Allow once",
  always: "Always allow",
  deny: "Deny",
};

export function AskActions({
  actions,
  disabled,
  onAnswer,
}: {
  actions: AskAction[];
  disabled?: boolean;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const submitting = pendingAction !== null;

  async function submit(answer: string) {
    if (disabled || submitting) return;
    setPendingAction(answer);
    try {
      await onAnswer(answer);
    } catch (error) {
      Alert.alert(
        t("Could not submit answer"),
        error instanceof Error ? error.message : t("Please try again."),
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      {actions.map((action) => {
        const emphasized = action.id === "allow" || action.id === "always";
        return (
          <Pressable
            key={action.id}
            disabled={disabled || submitting}
            onPress={() => void submit(action.id)}
            style={{
              alignSelf: "stretch",
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              backgroundColor: emphasized ? tokens.muted : "transparent",
              borderWidth: 1,
              borderColor: tokens.border,
              opacity: disabled || submitting ? 0.5 : 1,
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: 15,
                fontWeight: emphasized ? "600" : "400",
              }}
            >
              {pendingAction === action.id
                ? t("Sending…")
                : Object.hasOwn(KNOWN_ASK_ACTION_LABELS, action.id)
                  ? t(KNOWN_ASK_ACTION_LABELS[action.id]!)
                  : action.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
