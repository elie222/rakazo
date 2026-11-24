import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { replyAttachment } from "@rakazo/core";
import type { ReactNode } from "react";
import { useContext, useEffect, useRef } from "react";
import { Image, Platform, Pressable, Text, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileMessage } from "../../lib/api/mobile-types";
import { mobileTokens } from "../../lib/appearance/appearance";
import type { MobileArtifactTarget } from "../../lib/artifacts/artifact-open";
import { CallKeyboardContext } from "../../lib/calls/call-keyboard-context";
import type { ThreadColumnPadding } from "../../lib/thread/scroll/thread-edges";
import type { PendingAttachment } from "../../lib/thread/send/thread-attachments";
import { previewMessageText } from "../../lib/thread/thread-message-text";
import { ComposerReplyPreview } from "../composer/composer-reply-preview";
import { ReplyDismissButton } from "../composer/reply-dismiss-button";
import { GlassSurface } from "../native/glass-surface";
import { NativeSymbol } from "../native/native-symbol";
import { ThreadEdgeFade } from "./thread-edge-fade";

/**
 * Holds the composer above the keyboard, with the reply being written and the draft's
 * attachments over it.
 */
export function ThreadComposerDock({
  hidden,
  keyboardProgress,
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
  selectionBar,
  children,
}: {
  hidden: boolean;
  /** Frame by frame, including a swipe that drags the keyboard down. */
  keyboardProgress: SharedValue<number>;
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
  /** Takes the composer's place while messages are being chosen; the composer stays mounted. */
  selectionBar?: ReactNode;
  children: ReactNode;
}) {
  const tokens = mobileTokens();
  const { t } = useLingui();
  const insets = useSafeAreaInsets();
  const rootOwnsBottom = useContext(CallKeyboardContext);
  // An iPhone window that runs the screen's full height, status bar to home indicator, rests the
  // input on the safe area as system apps do. Other iOS windows (landscape, iPad, one pane of a
  // dual-screen phone) keep it just above the indicator.
  const fullHeightPhone = Platform.OS === "ios" && !Platform.isPad && insets.top > 0;
  const composerRestingPadding = rootOwnsBottom
    ? 12
    : fullHeightPhone
      ? insets.bottom
      : Platform.OS === "ios"
        ? Math.max(insets.bottom - 14, 8)
        : Math.max(insets.bottom + 12, 24);
  // Hands the composer from the keyboard to the safe area as the keyboard moves, so it never
  // dips into the home indicator and then jumps back up.
  const composerKeyboardPadding = useAnimatedStyle(() => ({
    paddingBottom: interpolate(keyboardProgress.value, [0, 1], [composerRestingPadding, 12]),
  }));

  // Ends about halfway up the input, following it as the keyboard moves.
  const fadeHeight = useAnimatedStyle(() => ({
    height: interpolate(keyboardProgress.value, [0, 1], [composerRestingPadding, 12]) + 22,
  }));

  // A read-only chat has no composer, but its messages can still be chosen and copied.
  const controlsShown = !hidden || Boolean(selectionBar);
  const noticeHeight = useRef(0);
  const controlsHeight = useRef(0);
  const report = () =>
    onHeight(
      noticeHeight.current + (controlsShown ? controlsHeight.current + composerRestingPadding : 0),
    );
  useEffect(report, [composerRestingPadding, controlsShown, onHeight]);

  return (
    // Floats over the messages, which scroll underneath it; only its controls take touches.
    <View
      pointerEvents="box-none"
      style={[
        { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "100%" },
        columnPadding,
      ]}
    >
      {controlsShown ? <ThreadEdgeFade edge="bottom" style={fadeHeight} /> : null}
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
        style={[
          { display: controlsShown ? "flex" : "none", flexShrink: 1 },
          composerKeyboardPadding,
        ]}
      >
        <View
          pointerEvents="box-none"
          style={{ flexShrink: 1 }}
          onLayout={(event) => {
            controlsHeight.current = event.nativeEvent.layout.height;
            report();
          }}
        >
          {selectionBar}
          <View
            pointerEvents="box-none"
            style={{ display: selectionBar || hidden ? "none" : "flex", flexShrink: 1 }}
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
        </View>
      </Animated.View>
    </View>
  );
}
