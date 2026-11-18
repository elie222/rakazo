import { useLingui } from "@lingui/react/macro";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { resolveAskChoice } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { useState } from "react";
import type { ViewProps } from "react-native";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import type { AskAction } from "../../lib/cards/ask-action-label";
import { askActionLabel } from "../../lib/cards/ask-action-label";
import { native } from "../../lib/native/native";
import { NativeActionButton } from "../native/native-action-button";
import { NativeSymbol } from "../native/native-symbol";

const styles = StyleSheet.create({
  option: {
    alignItems: "center",
    borderRadius: 12,
    flexDirection: "row",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  optionLabel: { ...typeScale.body, flex: 1 },
});

export function AskActions({
  actions,
  site,
  approval,
  instructions,
  disabled,
  selectedAnswer,
  onAnswer,
  accessibilityActions,
  onAccessibilityAction,
}: {
  actions: AskAction[];
  site?: string;
  approval: boolean;
  instructions?: string;
  disabled?: boolean;
  selectedAnswer?: string;
  onAnswer: (answer: string) => Promise<void>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(instructions ?? "");
  const submitting = pendingAction !== null;
  const displayActions =
    instructions !== undefined
      ? actions.flatMap((action) =>
          action.id === "allow"
            ? [action, { id: "edit", label: editing ? t`Cancel` : t`Edit` }]
            : [action],
        )
      : actions;

  async function submit(answer: string) {
    if (disabled || submitting) return;
    setPendingAction(answer);
    try {
      await onAnswer(answer);
    } catch (error) {
      Alert.alert(t`Could not submit answer`, errorText(error, t`Please try again.`));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      {editing ? (
        <TextInput
          accessibilityLabel={t`Instructions`}
          multiline
          maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
          value={draft}
          onChangeText={setDraft}
          style={{ color: tokens.foreground, backgroundColor: native.fill, padding: 12 }}
        />
      ) : null}
      <View
        style={{
          flexDirection: approval ? "row" : "column",
          // Option rows stack full width; a wrapping column sizes its line to the
          // widest row's own width, which collapses stretched rows.
          flexWrap: approval ? "wrap" : "nowrap",
          gap: approval ? 6 : 8,
        }}
      >
        {displayActions.map((action) => {
          const emphasized = action.id === "allow" || action.id === "always";
          if (instructions !== undefined)
            return (
              <NativeActionButton
                key={action.id}
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                label={
                  action.id === "edit"
                    ? action.label
                    : action.id === "allow"
                      ? t`Apply`
                      : t`Dismiss`
                }
                prominence={emphasized ? "primary" : "secondary"}
                fill={false}
                disabled={disabled || submitting}
                busy={pendingAction === action.id || (action.id === "allow" && submitting)}
                onPress={() =>
                  action.id === "edit"
                    ? setEditing((value) => !value)
                    : void submit(
                        editing && action.id === "allow"
                          ? JSON.stringify({ instructions: draft })
                          : action.id,
                      )
                }
              />
            );
          const label = askActionLabel(action, { approval, site });
          if (approval)
            return (
              <NativeActionButton
                key={action.id}
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                label={label}
                prominence={emphasized ? "primary" : "secondary"}
                fill={false}
                disabled={disabled || submitting}
                busy={pendingAction === action.id}
                onPress={() => void submit(action.id)}
              />
            );
          // A question's options read as a list of answers, not a stack of call-to-action pills.
          const chosen =
            selectedAnswer !== undefined &&
            resolveAskChoice(selectedAnswer, actions)?.id === action.id;
          const inactive = disabled || submitting;
          return (
            <Pressable
              key={action.id}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{
                disabled: inactive,
                // Options carry a selection state only once the question has an answer.
                ...(selectedAnswer === undefined ? {} : { selected: chosen }),
              }}
              accessibilityActions={accessibilityActions}
              onAccessibilityAction={onAccessibilityAction}
              disabled={inactive}
              onPress={() => void submit(action.id)}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: pressed || chosen ? native.fillPressed : native.page,
                  opacity: inactive && !chosen && pendingAction !== action.id ? 0.6 : 1,
                },
              ]}
            >
              <Text
                style={[
                  styles.optionLabel,
                  { color: disabled && !chosen ? tokens.mutedForeground : tokens.foreground },
                ]}
              >
                {label}
              </Text>
              {pendingAction === action.id ? (
                <ActivityIndicator size="small" color={tokens.mutedForeground} />
              ) : chosen ? (
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
