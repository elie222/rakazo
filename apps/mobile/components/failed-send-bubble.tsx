import { isModelRequiredSendError } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { ActionSheetIOS, Alert, Image, Platform, Pressable, Text, View } from "react-native";
import { customErrorTextStyle, customFontFamily, useCustomSettings } from "../lib/custom-settings";
import { useI18n } from "../lib/i18n";
import { openModelSettings } from "../lib/model-settings";
import { useMobileTokens } from "../lib/native";
import type { SendAttempt } from "../lib/thread-feedback";
import type { UserBubble } from "../lib/user-bubble";
import { withUserBubble } from "../lib/user-bubble";
import { NativeSymbol } from "./native-symbol";

export function FailedSendBubble({
  attempt,
  onRetry,
  onDelete,
  needsModel,
  userBubble,
  userId,
}: {
  attempt: SendAttempt;
  onRetry: () => void;
  onDelete: () => void;
  /** Whether the account still has no model; unknown keeps the saved send error. */
  needsModel?: boolean;
  userBubble?: UserBubble;
  /** The account whose interface settings style this bubble's text. */
  userId?: string;
}) {
  const { t } = useI18n();
  const tokens = withUserBubble(useMobileTokens(), userBubble);
  const { payload, state } = attempt;
  const sending = state === "pending";
  const retryable = state === "failed" || state === "queued";
  const customSettings = useCustomSettings(userId ?? "");
  // The failed message itself keeps the conversation font; its "Not sent" caption
  // takes the error font (a sending message is a status, not an error, and stays grey).
  const chatSize = customSettings.font.chat.size;
  const chatColor = customSettings.font.chat.color;
  const chatFamily = customFontFamily(customSettings);
  const errorStyle = customErrorTextStyle(customSettings);
  // Once a model is connected, the saved missing-model error is stale and retrying can work.
  const modelRequired = isModelRequiredSendError(attempt.error) && needsModel !== false;
  // A missing model isn't fixed by retrying, so the caption names the cause instead.
  const caption = sending
    ? t("Sending…")
    : attempt.imageConfirmation
      ? t("Not sent. Tap for options")
      : modelRequired
        ? t("Not sent. No model")
        : retryable
          ? t("Not sent. Tap to retry")
          : t("Not sent");
  const messageLabel = [payload.displayText, ...payload.attachments.map(({ name }) => name)]
    .filter(Boolean)
    .join(", ");
  const color = sending ? tokens.mutedForeground : tokens.destructive;

  function showActions(manage = true) {
    const actions = [
      ...(modelRequired ? [{ text: t("Add model"), onPress: openModelSettings }] : []),
      ...(attempt.imageConfirmation
        ? [
            {
              text: t("Send as file"),
              onPress: () => {
                attempt.imageHandling = "file";
                onRetry();
              },
            },
          ]
        : []),
      // Retrying can't help until a model is added; tapping the bubble still retries.
      ...(retryable && !modelRequired && !attempt.imageConfirmation
        ? [{ text: t("Try again"), onPress: onRetry }]
        : []),
      ...(attempt.imageConfirmation && !manage
        ? [{ text: t("Try again"), onPress: onRetry }]
        : [{ text: t("Delete"), style: "destructive" as const, onPress: onDelete }]),
    ];
    // No header for a missing-model failure: Add model says it, and once connected it's stale.
    // A file choice must not suggest the model will understand the picture.
    const message = isModelRequiredSendError(attempt.error)
      ? undefined
      : attempt.imageConfirmation
        ? [attempt.error, t("The bot can use the file but won't see the picture.")]
            .filter(Boolean)
            .join("\n\n")
        : attempt.error;
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          message,
          options: [...actions.map((action) => action.text), t("Cancel")],
          destructiveButtonIndex:
            attempt.imageConfirmation && !manage ? undefined : actions.length - 1,
          cancelButtonIndex: actions.length,
        },
        (index) => actions[index]?.onPress(),
      );
    } else {
      // Android supports three buttons; the sheet can also be dismissed outside it.
      Alert.alert(caption, message, [...actions, { text: t("Cancel"), style: "cancel" as const }], {
        cancelable: true,
      });
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={messageLabel ? `${messageLabel}. ${caption}` : caption}
      accessibilityHint={sending ? undefined : t("Long press to delete")}
      accessibilityState={{ disabled: sending }}
      disabled={sending}
      onPress={
        attempt.imageConfirmation ? () => showActions(false) : retryable ? onRetry : undefined
      }
      onLongPress={() => showActions()}
      style={{ alignSelf: "flex-end", maxWidth: "90%", marginTop: 12, gap: 4 }}
    >
      <View
        style={{
          borderRadius: 20,
          backgroundColor: customSettings.messageBackgrounds.user ?? tokens.chatUser,
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 8,
          opacity: 0.8,
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
          <Text
            style={{
              color: chatColor ?? tokens.chatUserForeground,
              ...typeScale.body,
              fontSize: chatSize,
              lineHeight: Math.round(
                (chatSize * typeScale.body.lineHeight) / typeScale.body.fontSize,
              ),
              ...(chatFamily ? { fontFamily: chatFamily } : null),
            }}
          >
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
      <View
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 }}
      >
        {!sending ? (
          <NativeSymbol
            ios="exclamationmark.circle.fill"
            android="alert-circle"
            size={13}
            color={color}
          />
        ) : null}
        <Text
          style={
            sending ? { color, fontSize: 13 } : [errorStyle, { color: errorStyle.color ?? color }]
          }
        >
          {caption}
        </Text>
      </View>
    </Pressable>
  );
}
