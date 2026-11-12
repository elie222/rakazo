import { useLingui } from "@lingui/react/macro";
import { isModelRequiredSendError } from "@rakazo/core";
import { sendEntrance, typeScale } from "@rakazo/ui-tokens";
import { useEffect, useState } from "react";
import { Alert, Image, Platform, Pressable, Text, View } from "react-native";
import type { EntryExitAnimationFunction } from "react-native-reanimated";
import Animated, { Easing, FadeIn, useReducedMotion, withTiming } from "react-native-reanimated";
import { showIOSActionSheet } from "../lib/ios-action-sheet";
import { openModelSettings } from "../lib/model-settings";
import { useMobileTokens } from "../lib/native";
import type { SendAttempt } from "../lib/thread-feedback";
import { isFreshSend } from "../lib/thread-feedback";
import type { UserBubble } from "../lib/user-bubble";
import { withUserBubble } from "../lib/user-bubble";
import { NativeSymbol } from "./native-symbol";

/**
 * A message just sent rises into place above the composer: it starts this far below and this
 * faint, and eases out over this long, with no bounce.
 */
export const SEND_ENTER = sendEntrance;
/** "Sending…" shows only once a send takes this long; a quick send never shows it. */
export const SLOW_SEND_MS = 1500;
const CAPTION_FADE_MS = 200;

// The list is inverted, but its header cell is flipped back upright, so a positive
// translateY here is down on screen.
const sendEntering: EntryExitAnimationFunction = () => {
  "worklet";
  const timing = { duration: SEND_ENTER.ms, easing: Easing.out(Easing.cubic) };
  return {
    initialValues: { opacity: SEND_ENTER.opacity, transform: [{ translateY: SEND_ENTER.offset }] },
    animations: {
      opacity: withTiming(1, timing),
      transform: [{ translateY: withTiming(0, timing) }],
    },
  };
};

export function FailedSendBubble({
  attempt,
  onRetry,
  onDelete,
  needsModel,
  userBubble,
}: {
  attempt: SendAttempt;
  onRetry: () => void;
  onDelete: () => void;
  /** Whether the account still has no model; unknown keeps the saved send error. */
  needsModel?: boolean;
  userBubble?: UserBubble;
}) {
  const { t } = useLingui();
  const tokens = withUserBubble(useMobileTokens(), userBubble);
  const reducedMotion = useReducedMotion();
  // Decided once, on mount: a later render, a restored send or a retry never slides in.
  const [entering] = useState(() => isFreshSend(attempt));
  const { payload, state } = attempt;
  const sending = state === "pending";
  // The bubble is the message, so a quick send shows no caption: the hand-off to the saved
  // message then neither moves nor flashes. Only a slow send says it is still sending.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!sending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), SLOW_SEND_MS);
    return () => clearTimeout(timer);
  }, [sending]);
  const retryable = state === "failed" || state === "queued";
  // Once a model is connected, the saved missing-model error is stale and retrying can work.
  const modelRequired = isModelRequiredSendError(attempt.error) && needsModel !== false;
  // A missing model isn't fixed by retrying, so the caption names the cause instead.
  const caption = sending
    ? t`Sending…`
    : attempt.imageConfirmation
      ? t`Not sent. Tap for options`
      : modelRequired
        ? t`Not sent. No model`
        : retryable
          ? t`Not sent. Tap to retry`
          : t`Not sent`;
  const messageLabel = [payload.displayText, ...payload.attachments.map(({ name }) => name)]
    .filter(Boolean)
    .join(", ");
  const color = sending ? tokens.mutedForeground : tokens.destructive;

  function showActions(manage = true) {
    const actions = [
      ...(modelRequired ? [{ text: t`Add model`, onPress: openModelSettings }] : []),
      ...(attempt.imageConfirmation
        ? [
            {
              text: t`Send as file`,
              onPress: () => {
                attempt.imageHandling = "file";
                onRetry();
              },
            },
          ]
        : []),
      // Retrying can't help until a model is added; tapping the bubble still retries.
      ...(retryable && !modelRequired && !attempt.imageConfirmation
        ? [{ text: t`Try again`, onPress: onRetry }]
        : []),
      ...(attempt.imageConfirmation && !manage
        ? [{ text: t`Try again`, onPress: onRetry }]
        : [{ text: t`Delete`, style: "destructive" as const, onPress: onDelete }]),
    ];
    // No header for a missing-model failure: Add model says it, and once connected it's stale.
    // A file choice must not suggest the model will understand the picture.
    const message = isModelRequiredSendError(attempt.error)
      ? undefined
      : attempt.imageConfirmation
        ? [attempt.error, t`The bot can use the file but won't see the picture.`]
            .filter(Boolean)
            .join("\n\n")
        : attempt.error;
    if (Platform.OS === "ios") {
      showIOSActionSheet(
        {
          message,
          options: [...actions.map((action) => action.text), t`Cancel`],
          destructiveButtonIndex:
            attempt.imageConfirmation && !manage ? undefined : actions.length - 1,
          cancelButtonIndex: actions.length,
        },
        (index) => actions[index]?.onPress(),
      );
    } else {
      // Android supports three buttons; the sheet can also be dismissed outside it.
      Alert.alert(caption, message, [...actions, { text: t`Cancel`, style: "cancel" as const }], {
        cancelable: true,
      });
    }
  }

  return (
    <Animated.View
      entering={entering && !reducedMotion ? sendEntering : undefined}
      style={{ alignSelf: "flex-end", maxWidth: "90%", marginTop: 12 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={messageLabel ? `${messageLabel}. ${caption}` : caption}
        accessibilityHint={sending ? undefined : t`Long press to delete`}
        accessibilityState={{ disabled: sending }}
        disabled={sending}
        onPress={
          attempt.imageConfirmation ? () => showActions(false) : retryable ? onRetry : undefined
        }
        onLongPress={() => showActions()}
        style={{ gap: 4 }}
      >
        <View
          style={{
            borderRadius: 20,
            backgroundColor: tokens.chatUser,
            paddingHorizontal: 14,
            paddingVertical: 12,
            gap: 8,
            // A message on its way looks sent; one that failed fades back.
            opacity: sending ? 1 : 0.8,
          }}
        >
          {payload.replyPreview ? (
            <Text
              numberOfLines={3}
              style={{
                color: tokens.chatUserForeground,
                fontSize: 13,
                borderLeftWidth: 2,
                borderLeftColor: tokens.border,
                paddingLeft: 8,
              }}
            >
              {payload.replyPreview}
            </Text>
          ) : null}
          {payload.displayText ? (
            <Text style={{ color: tokens.chatUserForeground, ...typeScale.body }}>
              {payload.displayText}
            </Text>
          ) : null}
          {payload.attachments.map((attachment) => (
            <View key={attachment.id} style={{ gap: 4 }}>
              {attachment.previewUri ? (
                <Image
                  source={{ uri: attachment.previewUri }}
                  style={{ width: 180, height: 120, borderRadius: 12 }}
                />
              ) : null}
              <Text style={{ color: tokens.chatUserForeground, fontSize: 13 }}>
                {attachment.name}
              </Text>
            </View>
          ))}
        </View>
        {!sending || slow ? (
          <Animated.View
            entering={sending && !reducedMotion ? FadeIn.duration(CAPTION_FADE_MS) : undefined}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 4,
            }}
          >
            {!sending ? (
              <NativeSymbol
                ios="exclamationmark.circle.fill"
                android="alert-circle"
                size={13}
                color={color}
              />
            ) : null}
            <Text style={{ color, fontSize: 13 }}>{caption}</Text>
          </Animated.View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}
