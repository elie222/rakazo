import { replyAttachment } from "@rakazo/core";
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Image, Platform, Pressable, Text, View } from "react-native";
import { KeyboardController, useKeyboardHandler } from "react-native-keyboard-controller";
import Animated, { interpolate, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileMessage } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import type { MobileArtifactTarget } from "../../lib/artifact-open";
import { useI18n } from "../../lib/i18n";
import type { PendingAttachment } from "../../lib/thread-attachments";
import { previewMessageText } from "../../lib/thread-message-text";
import { ComposerReplyPreview } from "../composer-reply-preview";
import { GlassSurface } from "../glass-surface";
import { NativeSymbol } from "../native-symbol";
import { ReplyDismissButton } from "../reply-dismiss-button";

/**
 * Holds the composer above the keyboard, with the reply being written and the draft's
 * attachments over it.
 */
export function ThreadComposerDock({
  hidden,
  fadeStyle,
  replyTarget,
  replyAuthor,
  replyQuote,
  threadTarget,
  onDismissReply,
  attachmentNotice,
  attachments,
  onRemoveAttachment,
  children,
}: {
  hidden: boolean;
  fadeStyle: StyleProp<ViewStyle>;
  replyTarget: MobileMessage | null;
  replyAuthor: string;
  replyQuote: string | null;
  threadTarget?: MobileArtifactTarget;
  onDismissReply: () => void;
  attachmentNotice: string | null;
  attachments: readonly PendingAttachment[];
  onRemoveAttachment: (id: string) => void;
  children: ReactNode;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  // Frame by frame, including a swipe that drags the keyboard down.
  const keyboardProgress = useSharedValue(KeyboardController.isVisible() ? 1 : 0);
  useKeyboardHandler(
    {
      onMove: (event) => {
        "worklet";
        keyboardProgress.value = event.progress;
      },
      onInteractive: (event) => {
        "worklet";
        keyboardProgress.value = event.progress;
      },
      onEnd: (event) => {
        "worklet";
        keyboardProgress.value = event.progress;
      },
    },
    [],
  );
  const composerRestingPadding =
    Platform.OS === "ios" ? insets.bottom : Math.max(insets.bottom + 12, 24);
  // Hands the composer from the keyboard to the safe area as the keyboard moves, so it never
  // dips into the home indicator and then jumps back up.
  const composerKeyboardPadding = useAnimatedStyle(() => ({
    paddingBottom: interpolate(keyboardProgress.value, [0, 1], [composerRestingPadding, 12]),
  }));

  return (
    <Animated.View
      style={[{ display: hidden ? "none" : "flex", flexShrink: 1 }, composerKeyboardPadding]}
    >
      {/* Fades messages out immediately above the composer. */}
      <View pointerEvents="none" style={fadeStyle} />
      {replyTarget ? (
        <GlassSurface
          style={{
            marginTop: 12,
            borderRadius: 999,
            paddingStart: 16,
            paddingEnd: 10,
            paddingVertical: 8,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
          }}
          fallbackStyle={{
            borderRadius: 14,
            borderWidth: 1,
            borderColor: tokens.glassStroke,
            backgroundColor: tokens.glassFill,
            paddingStart: 12,
            paddingEnd: 12,
            paddingVertical: 10,
          }}
        >
          <ComposerReplyPreview
            author={replyAuthor}
            quote={replyQuote}
            text={previewMessageText(replyTarget)}
            attachment={replyAttachment(replyTarget.blocks)}
            threadTarget={threadTarget}
          />
          <ReplyDismissButton onPress={onDismissReply} />
        </GlassSurface>
      ) : null}
      {attachmentNotice ? (
        <Text style={{ color: tokens.warning, marginTop: 12, fontSize: 13 }}>
          {attachmentNotice}
        </Text>
      ) : null}
      {attachments.length ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 12,
          }}
        >
          {attachments.map((attachment) => (
            <View
              key={attachment.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: tokens.border,
                backgroundColor: tokens.card,
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              {attachment.previewUri ? (
                <Image
                  source={{ uri: attachment.previewUri }}
                  style={{ width: 28, height: 28, borderRadius: 6 }}
                />
              ) : (
                <NativeSymbol
                  ios="paperclip"
                  android="attach"
                  size={16}
                  color={tokens.mutedForeground}
                />
              )}
              <Text style={{ color: tokens.foreground, maxWidth: 140 }} numberOfLines={1}>
                {attachment.name}
              </Text>
              <Pressable
                accessibilityLabel={t("Remove {name}", { name: attachment.name })}
                onPress={() => onRemoveAttachment(attachment.id)}
              >
                <NativeSymbol
                  ios="xmark"
                  android="close"
                  size={14}
                  color={tokens.mutedForeground}
                />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {children}
    </Animated.View>
  );
}
