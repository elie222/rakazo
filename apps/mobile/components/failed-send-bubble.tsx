import { ActionSheetIOS, Alert, Image, Platform, Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import type { SendAttempt } from "../lib/thread-feedback";
import { NativeSymbol } from "./native-symbol";

export function FailedSendBubble({
  attempt,
  onRetry,
  onDelete,
}: {
  attempt: SendAttempt;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { payload, state } = attempt;
  const sending = state === "pending";
  const retryable = state === "failed" || state === "queued";
  const caption = sending
    ? t("Sending…")
    : retryable
      ? t("Not sent · Tap to retry")
      : t("Not sent");
  const messageLabel = [payload.displayText, ...payload.attachments.map(({ name }) => name)]
    .filter(Boolean)
    .join(", ");
  const color = sending ? tokens.mutedForeground : tokens.destructive;

  function showActions() {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          message: attempt.error,
          options: retryable
            ? [t("Try Again"), t("Delete"), t("Cancel")]
            : [t("Delete"), t("Cancel")],
          destructiveButtonIndex: retryable ? 1 : 0,
          cancelButtonIndex: retryable ? 2 : 1,
        },
        (index) => {
          if (retryable && index === 0) onRetry();
          if (index === (retryable ? 1 : 0)) onDelete();
        },
      );
    } else {
      Alert.alert(caption, attempt.error, [
        ...(retryable ? [{ text: t("Try Again"), onPress: onRetry }] : []),
        { text: t("Delete"), style: "destructive", onPress: onDelete },
        { text: t("Cancel"), style: "cancel" },
      ]);
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={messageLabel ? `${messageLabel}. ${caption}` : caption}
      accessibilityHint={sending ? undefined : t("Long press to delete")}
      accessibilityState={{ disabled: sending }}
      disabled={sending}
      onPress={retryable ? onRetry : undefined}
      onLongPress={showActions}
      style={{ alignSelf: "flex-end", maxWidth: "90%", marginTop: 12, gap: 4 }}
    >
      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.secondary,
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
              color: tokens.mutedForeground,
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
          <Text style={{ color: tokens.secondaryForeground, fontSize: 15.5, lineHeight: 23 }}>
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
            <Text style={{ color: tokens.secondaryForeground, fontSize: 13 }}>
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
        <Text style={{ color, fontSize: 13 }}>{caption}</Text>
      </View>
    </Pressable>
  );
}
