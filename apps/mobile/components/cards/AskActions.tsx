import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { BOT_INSTRUCTIONS_MAX_LENGTH, THREAD_MESSAGE_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import type { DraftNonce } from "@rakazo/core";
import { draftNonce, resolveAskChoice } from "@rakazo/core";
import { routineApprovalActionLabel } from "@rakazo/i18n/routine-approval";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useRef, useState } from "react";
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
import { native, useResolvedAppearance } from "../../lib/native/native";
import { useInlineInputFocus } from "../../lib/thread/inline-input-focus";
import { NativeActionButton } from "../native/native-action-button";
import { NativeSymbol } from "../native/native-symbol";

const styles = StyleSheet.create({
  more: {
    alignItems: "center",
    justifyContent: "center",
    minWidth: 44,
    minHeight: 44,
  },
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
  input: {
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 11,
    ...typeScale.body,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
});

export function AskActions({
  actions,
  site,
  approval,
  instructions,
  routineUpdate,
  disabled,
  selectedAnswer,
  onAnswer,
  onTypeAnswer,
  accessibilityActions,
  onAccessibilityAction,
}: {
  actions: AskAction[];
  site?: string;
  approval: boolean;
  instructions?: string;
  routineUpdate?: boolean;
  disabled?: boolean;
  selectedAnswer?: string;
  onAnswer: (answer: string) => Promise<void>;
  /** Sends a free-text answer from an option card as the user's message replying to the card. */
  onTypeAnswer?: (answer: string, clientNonce: string) => Promise<void>;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useLingui();
  const tokens = mobileTokens();
  const notifyInlineInputFocus = useInlineInputFocus();
  const [pendingAction, setPendingAction] = useState<{ id?: string; typed?: true } | null>(null);
  const [acceptedAnswer, setAcceptedAnswer] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(instructions ?? "");
  const [typed, setTyped] = useState("");
  const [typedFocused, setTypedFocused] = useState(false);
  const submittingRef = useRef(false);
  const draftNonceRef = useRef<DraftNonce | null>(null);
  const submitting = pendingAction !== null;
  const settled = Boolean(disabled) || selectedAnswer !== undefined || acceptedAnswer !== undefined;
  const displayedAnswer = selectedAnswer ?? acceptedAnswer;
  const canTypeAnswer =
    !approval && instructions === undefined && !settled && onTypeAnswer !== undefined;
  const inlineAnswerOpen = canTypeAnswer && editing;
  useEffect(() => {
    if (!inlineAnswerOpen || !typedFocused) return;
    notifyInlineInputFocus?.(true);
    return () => notifyInlineInputFocus?.(false);
  }, [inlineAnswerOpen, typedFocused, notifyInlineInputFocus]);
  const always = routineUpdate && actions.some((action) => action.id === "always");
  const displayActions =
    instructions !== undefined
      ? actions.flatMap((action) =>
          action.id === "allow"
            ? [action, { id: "edit", label: editing ? t`Cancel` : t`Edit` }]
            : [action],
        )
      : actions;

  const inlineActions = always
    ? displayActions.filter((action) => action.id !== "always")
    : displayActions;

  async function submit(answer: string, target: { id?: string; typed?: true }) {
    if (settled || submittingRef.current || submitting) return;
    if (target.typed && !onTypeAnswer) return;
    submittingRef.current = true;
    setPendingAction(target);
    try {
      if (target.typed) {
        draftNonceRef.current = draftNonce(draftNonceRef.current, answer);
        await onTypeAnswer!(answer, draftNonceRef.current.nonce);
      } else {
        await onAnswer(answer);
      }
      setAcceptedAnswer(answer);
      if (target.typed) {
        draftNonceRef.current = null;
        setTyped("");
        setTypedFocused(false);
        setEditing(false);
      }
    } catch (error) {
      Alert.alert(t`Could not submit answer`, errorText(error, t`Please try again.`));
    } finally {
      submittingRef.current = false;
      setPendingAction(null);
    }
  }

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      {instructions !== undefined && editing ? (
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
        {inlineActions.map((action) => {
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
                disabled={settled || submitting}
                busy={pendingAction?.id === action.id || (action.id === "allow" && submitting)}
                onPress={() =>
                  action.id === "edit"
                    ? setEditing((value) => !value)
                    : void submit(
                        editing && action.id === "allow"
                          ? JSON.stringify({ instructions: draft })
                          : action.id,
                        { id: action.id },
                      )
                }
              />
            );
          const label =
            (routineUpdate && routineApprovalActionLabel(action.id)) ||
            askActionLabel(action, { approval, site });
          if (approval)
            return (
              <NativeActionButton
                key={action.id}
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                label={label}
                prominence={emphasized ? "primary" : "secondary"}
                fill={false}
                disabled={settled || submitting}
                busy={pendingAction?.id === action.id}
                onPress={() => void submit(action.id, { id: action.id })}
              />
            );
          // A question's options read as a list of answers, not a stack of call-to-action pills.
          const chosen =
            displayedAnswer !== undefined &&
            resolveAskChoice(displayedAnswer, actions)?.id === action.id;
          const inactive = settled || submitting;
          return (
            <Pressable
              key={action.id}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{
                disabled: inactive,
                // Options carry a selection state only once the question has an answer.
                ...(displayedAnswer === undefined ? {} : { selected: chosen }),
              }}
              accessibilityActions={accessibilityActions}
              onAccessibilityAction={onAccessibilityAction}
              disabled={inactive}
              onPress={() => void submit(action.id, { id: action.id })}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: pressed || chosen ? native.fillPressed : native.page,
                  opacity: inactive && !chosen && pendingAction?.id !== action.id ? 0.6 : 1,
                },
              ]}
            >
              <Text
                style={[
                  styles.optionLabel,
                  { color: settled && !chosen ? tokens.mutedForeground : tokens.foreground },
                ]}
              >
                {label}
              </Text>
              {pendingAction?.id === action.id ? (
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
        {always ? (
          <RoutineApprovalMenu
            disabled={settled || submitting}
            busy={pendingAction?.id === "always"}
            onApprove={() => void submit("always", { id: "always" })}
          />
        ) : null}
      </View>
      {canTypeAnswer ? (
        editing ? (
          <>
            <TextInput
              accessibilityLabel={t`Type your answer`}
              placeholder={t`Type your answer`}
              placeholderTextColor={tokens.faintForeground}
              maxLength={THREAD_MESSAGE_TEXT_MAX_LENGTH}
              value={typed}
              onChangeText={setTyped}
              onFocus={() => setTypedFocused(true)}
              onBlur={() => setTypedFocused(false)}
              autoCapitalize="sentences"
              editable={!submitting}
              returnKeyType="send"
              onSubmitEditing={() => {
                const trimmed = typed.trim();
                if (trimmed) void submit(trimmed, { typed: true });
              }}
              style={[
                styles.input,
                {
                  backgroundColor: native.page,
                  borderColor: tokens.border,
                  color: tokens.foreground,
                },
              ]}
            />
            <View style={styles.actions}>
              <NativeActionButton
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                label={t`Send answer`}
                fill={false}
                disabled={!typed.trim() || submitting}
                busy={Boolean(pendingAction?.typed)}
                onPress={() => {
                  const trimmed = typed.trim();
                  if (trimmed) void submit(trimmed, { typed: true });
                }}
              />
              <NativeActionButton
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                label={t`Cancel`}
                fill={false}
                disabled={submitting}
                prominence="secondary"
                onPress={() => {
                  draftNonceRef.current = null;
                  setTyped("");
                  setTypedFocused(false);
                  setEditing(false);
                }}
              />
            </View>
          </>
        ) : (
          <NativeActionButton
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            label={t`Type your answer`}
            disabled={submitting}
            prominence="quiet"
            fill={false}
            onPress={() => setEditing(true)}
          />
        )
      ) : null}
    </View>
  );
}

function RoutineApprovalMenu({
  disabled,
  busy,
  onApprove,
}: {
  disabled: boolean | undefined;
  busy: boolean;
  onApprove: () => void;
}) {
  const { t } = useLingui();
  const appearance = useResolvedAppearance();
  const tokens = mobileTokens();
  return (
    <MenuView
      actions={[
        {
          id: "always",
          title: routineApprovalActionLabel("always") ?? "",
          attributes: { disabled },
        },
      ]}
      colorScheme={appearance}
      onPressAction={onApprove}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityState={{ disabled, busy }}
        accessibilityLabel={busy ? t`Sending…` : t`More approval options`}
        style={styles.more}
      >
        <NativeSymbol
          ios="ellipsis"
          android="ellipsis-horizontal"
          size={20}
          color={tokens.foreground}
        />
      </View>
    </MenuView>
  );
}
