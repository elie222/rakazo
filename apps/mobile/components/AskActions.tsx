import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
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
    <View style={{ marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {actions.map((action) => (
        <Pressable
          key={action.id}
          disabled={disabled || submitting}
          onPress={() => void submit(action.id)}
          style={{
            borderRadius: 11,
            paddingHorizontal: 14,
            paddingVertical: 8,
            backgroundColor:
              action.id === "allow" || action.id === "always" ? "#F1F1EF" : "transparent",
            borderWidth: action.id === "deny" ? 1 : 0,
            borderColor: "#26262A",
            opacity: disabled || submitting ? 0.5 : 1,
          }}
        >
          <Text
            style={{
              color: action.id === "allow" || action.id === "always" ? "#17171A" : "#C9C9CE",
              fontSize: 14,
              fontWeight: action.id === "allow" || action.id === "always" ? "600" : "400",
            }}
          >
            {pendingAction === action.id
              ? t("Sending…")
              : Object.hasOwn(KNOWN_ASK_ACTION_LABELS, action.id)
                ? t(KNOWN_ASK_ACTION_LABELS[action.id]!)
                : action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
