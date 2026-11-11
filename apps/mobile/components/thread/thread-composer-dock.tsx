import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { replyAttachment } from "@rakazo/core";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { Image, Platform, Pressable, Text, View } from "react-native";
import { KeyboardController, useKeyboardHandler } from "react-native-keyboard-controller";
import Animated, { interpolate, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../../lib/appearance";
import type { MobileArtifactTarget } from "../../lib/artifact-open";
import type { MobileMessage } from "../../lib/mobile-types";
import type { PendingAttachment } from "../../lib/thread-attachments";
import type { ThreadColumnPadding } from "../../lib/thread-edges";
import { previewMessageText } from "../../lib/thread-message-text";
import { ComposerReplyPreview } from "../composer-reply-preview";
import { GlassSurface } from "../glass-surface";
import { NativeSymbol } from "../native-symbol";
import { ReplyDismissButton } from "../reply-dismiss-button";
import { ThreadEdgeFade } from "./thread-edge-fade";

/**
 * Holds the composer above the keyboard, with the reply being written and the draft's
 * attachments over it.
 */
export function ThreadComposerDock({
  hidden,
  columnPadding,
  notice,
  onHeight,
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
  columnPadding: ThreadColumnPadding;
  /** Shown above the reply, as part of the dock. */
  notice: ReactNode;
  /** The space the list must keep clear: the dock at rest, not following the keyboard. */
  onHeight: (height: number) => void;
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
  const { t } = useLingui();
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

  // Reaches from the bottom edge to about the middle of the input.
  const fadeHeight = composerRestingPadding + 48;

  const noticeHeight = useRef(0);
  const controlsHeight = useRef(0);
  const report = () =>
    onHeight(noticeHeight.current + (hidden ? 0 : controlsHeight.current + composerRestingPadding));
  useEffect(report, [composerRestingPadding, hidden, onHeight]);

  return (
    // Floats over the messages, which scroll underneath it; only its controls take touches.
    <View
      pointerEvents="box-none"
      style={[
        { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "100%" },
        columnPadding,
      ]}
    >
      {hidden ? null : <ThreadEdgeFade edge="bottom" height={fadeHeight} />}
      <View
        pointerEvents="box-none"
        onLayout={(event) => {
          noticeHeight.current = event.nativeEvent.layout.height;
          report();
        }}
      >
        {notice}
      </View>
      <Animated.View
        pointerEvents="box-none"
        style={[{ display: hidden ? "none" : "flex", flexShrink: 1 }, composerKeyboardPadding]}
      >
        <View
          pointerEvents="box-none"
          style={{ flexShrink: 1 }}
          onLayout={(event) => {
            controlsHeight.current = event.nativeEvent.layout.height;
            report();
          }}
        >
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
                    accessibilityLabel={t`Remove ${ph({ name: attachment.name })}`}
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
        </View>
      </Animated.View>
    </View>
  );
}
