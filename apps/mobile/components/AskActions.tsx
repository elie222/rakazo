import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { useState } from "react";
import type { ViewProps } from "react-native";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { errorText } from "../lib/user-error";

type AskAction = { id: string; label: string };

const KNOWN_ASK_ACTION_LABELS: Record<string, string> = {
  allow: "Allow once",
  always: "Always allow",
  deny: "Deny",
};

export function AskActions({
  actions,
  instructions,
  disabled,
  onAnswer,
  accessibilityActions,
  onAccessibilityAction,
}: {
  actions: AskAction[];
  instructions?: string;
  disabled?: boolean;
  onAnswer: (answer: string) => Promise<void>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(instructions ?? "");
  const submitting = pendingAction !== null;
  const displayActions =
    instructions !== undefined
      ? actions.flatMap((action) =>
          action.id === "allow"
            ? [action, { id: "edit", label: t(editing ? "Cancel" : "Edit") }]
            : [action],
        )
      : actions;

  async function submit(answer: string) {
    if (disabled || submitting) return;
    setPendingAction(answer);
    try {
      await onAnswer(answer);
    } catch (error) {
      Alert.alert(t("Could not submit answer"), errorText(error, t("Please try again.")));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      {editing ? (
        <TextInput
          accessibilityLabel={t("Instructions")}
          multiline
          maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
          value={draft}
          onChangeText={setDraft}
          style={{ color: tokens.foreground, backgroundColor: native.fill, padding: 12 }}
        />
      ) : null}
      {displayActions.map((action) => {
        const emphasized = action.id === "allow" || action.id === "always";
        return (
          <Pressable
            key={action.id}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            disabled={disabled || submitting}
            onPress={() =>
              action.id === "edit" && instructions !== undefined
                ? setEditing((value) => !value)
                : void submit(
                    editing && action.id === "allow"
                      ? JSON.stringify({ instructions: draft })
                      : action.id,
                  )
            }
            style={{
              alignSelf: "stretch",
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              backgroundColor: emphasized ? native.fillPressed : native.fill,
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
                : action.id === "edit" && instructions !== undefined
                  ? action.label
                  : instructions !== undefined
                    ? t(action.id === "allow" ? "Apply" : "Dismiss")
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
