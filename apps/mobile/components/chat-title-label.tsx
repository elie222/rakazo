import { useRef } from "react";
import type { TextStyle } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { HEADER_TITLE_MAX_FONT_SCALE } from "../lib/native-controls";

/** How long a placeholder title takes to cross-fade into the real name. */
export const CHAT_TITLE_FADE_MS = 180;

/**
 * A chat title's name, shown at once when the chat opens. Only when the chat opened with a
 * placeholder ("Bot", before its name is known) does it cross-fade into the real name: the
 * placeholder fades out where it was while the name fades in. Reduce Motion skips both fades.
 */
export function ChatTitleLabel({
  label,
  placeholder,
  style,
}: {
  label: string;
  placeholder: boolean;
  style: TextStyle;
}) {
  const openedWithPlaceholder = useRef(placeholder).current;
  return (
    <Animated.Text
      key={placeholder ? "placeholder" : "name"}
      entering={
        openedWithPlaceholder && !placeholder ? FadeIn.duration(CHAT_TITLE_FADE_MS) : undefined
      }
      exiting={placeholder ? FadeOut.duration(CHAT_TITLE_FADE_MS) : undefined}
      maxFontSizeMultiplier={HEADER_TITLE_MAX_FONT_SCALE}
      numberOfLines={1}
      style={style}
    >
      {label}
    </Animated.Text>
  );
}
