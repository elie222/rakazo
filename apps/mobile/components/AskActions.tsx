import { useLingui } from "@lingui/react/macro";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { resolveAskChoice } from "@rakazo/core";
import { useState } from "react";
import type { ViewProps } from "react-native";
import { Alert, TextInput, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import type { AskAction } from "../lib/ask-action-label";
import { askActionLabel } from "../lib/ask-action-label";
import { native } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

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
          // Option buttons stack full width; a wrapping column sizes its line to the
          // widest button's own width, which collapses stretched buttons.
          flexWrap: approval ? "wrap" : "nowrap",
          gap: 6,
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
          return (
            <NativeActionButton
              key={action.id}
              accessibilityActions={accessibilityActions}
              onAccessibilityAction={onAccessibilityAction}
              label={askActionLabel(action, { approval, site })}
              prominence={emphasized ? "primary" : "secondary"}
              fill={!approval}
              selected={
                !approval && resolveAskChoice(selectedAnswer ?? "", actions)?.id === action.id
              }
              align={approval ? "center" : "start"}
              disabled={disabled || submitting}
              busy={pendingAction === action.id}
              onPress={() => void submit(action.id)}
            />
          );
        })}
      </View>
    </View>
  );
}
