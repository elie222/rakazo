import type { BotAvatarSet } from "@rakazo/contracts";
import { avatarPhotoDot } from "@rakazo/core";
import { MAX_FONT_SCALE, typeScale } from "@rakazo/ui-tokens";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useAvatarOnScreen } from "../lib/avatar-life";
import { useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";

/** A working bot; `composing` while it writes reply text (the mark turns into dots). */
export type ActivityMarkBot = {
  id: string;
  color: string;
  avatarSet?: BotAvatarSet;
  status?: string;
  composing?: boolean;
};

/** The mark is the bot's 28 pt avatar. */
export const MARK_SIZE = 28;
/** The mark row's height, with room for a tap's hop, and how long it takes to open. */
export const ROW_HEIGHT = 40;
export const ROW_MS = 260;
/** The row opens quickly and slows into place. */
const ROW_EASING = Easing.out(Easing.cubic);
/** The spring the mark grows in with, once the row is open: a small, friendly overshoot. */
export const MARK_SPRING = { duration: 480, dampingRatio: 0.6 } as const;
/** The plain typing dots that stand in for a photo: dot size and gap. */
const PHOTO_DOT = { size: 6, gap: 4 };
/** In a group, the mark shows each working member in turn. */
const CYCLE_MS = 2000;
const SWAP_MS = 350;
const CROSSFADE = { entering: FadeIn.duration(SWAP_MS), exiting: FadeOut.duration(SWAP_MS) };
/** A clock long enough to never wrap while the photo dots pulse. */
const DOTS_RUN_MS = 24 * 60 * 60 * 1000;

/**
 * The bot at the end of a chat while it works: its avatar moves (or turns into the
 * typing dots while it writes) and plays a little reaction when tapped. It grows in once
 * the chat is scrolled to the newest message. `label` says what it is doing beside it.
 */
export function ActivityMark({
  bots,
  atBottom,
  label,
}: {
  bots: readonly ActivityMarkBot[];
  atBottom: boolean;
  label?: string;
}) {
  const tokens = useMobileTokens();
  const reducedMotion = useReducedMotion();
  // A covered screen or a backgrounded app neither cycles members nor pulses dots.
  const onScreen = useAvatarOnScreen();
  const [index, setIndex] = useState(0);
  const height = useSharedValue(reducedMotion ? ROW_HEIGHT : 0);
  const scale = useSharedValue(reducedMotion ? 1 : 0);
  const [arrived, setArrived] = useState(reducedMotion);

  useEffect(() => {
    height.value = withTiming(ROW_HEIGHT, { duration: ROW_MS, easing: ROW_EASING });
  }, [height]);
  useEffect(() => {
    if (arrived || !atBottom) return;
    setArrived(true);
    scale.value = withSpring(1, MARK_SPRING);
  }, [arrived, atBottom, scale]);
  useEffect(() => {
    if (bots.length < 2 || reducedMotion || !onScreen) return;
    const timer = setInterval(() => setIndex((current) => current + 1), CYCLE_MS);
    return () => clearInterval(timer);
  }, [bots.length, reducedMotion, onScreen]);

  const rowStyle = useAnimatedStyle(() => ({ height: height.value }));
  const markStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const bot = bots[index % bots.length];
  if (!bot) return null;
  const photo = bot.color.startsWith("data:image/");
  return (
    <Animated.View
      exiting={reducedMotion ? undefined : FadeOut.duration(ROW_MS)}
      style={[{ flexDirection: "row", alignItems: "center", gap: 8, overflow: "hidden" }, rowStyle]}
    >
      <Animated.View style={[{ width: MARK_SIZE, height: MARK_SIZE }, markStyle]}>
        <Animated.View
          key={bot.id}
          entering={bots.length > 1 ? CROSSFADE.entering : undefined}
          exiting={bots.length > 1 ? CROSSFADE.exiting : undefined}
          style={{ position: "absolute" }}
        >
          {photo ? (
            <PhotoDots typing={bot.composing ?? false} paused={!onScreen} />
          ) : (
            <BotAvatar
              color={bot.color}
              avatarSet={bot.avatarSet}
              identity={bot.id}
              size={MARK_SIZE}
              status={bot.status}
              motion="running"
              composing={bot.composing ?? false}
              pokeable
            />
          )}
        </Animated.View>
      </Animated.View>
      {label ? (
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={{ flexShrink: 1, color: tokens.mutedForeground, ...typeScale.secondary }}
        >
          {label}
        </Text>
      ) : null}
    </Animated.View>
  );
}

/** A photo can't move or turn into the typing dots, so plain typing dots stand in for it. */
function PhotoDots({ typing, paused }: { typing: boolean; paused: boolean }) {
  const tokens = useMobileTokens();
  const reducedMotion = useReducedMotion();
  const ms = useSharedValue(0);
  useEffect(() => {
    if (reducedMotion || paused) return;
    // Resume from where the pulse stopped.
    ms.value = withTiming(ms.value + DOTS_RUN_MS, { duration: DOTS_RUN_MS, easing: Easing.linear });
    return () => cancelAnimation(ms);
  }, [ms, reducedMotion, paused]);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: MARK_SIZE,
        height: MARK_SIZE,
        flexDirection: "row",
        alignItems: "center",
        gap: PHOTO_DOT.gap,
      }}
    >
      {([0, 1, 2] as const).map((slot) => (
        <PhotoDot
          key={slot}
          slot={slot}
          ms={ms}
          typing={typing}
          still={reducedMotion}
          color={tokens.mutedForeground}
        />
      ))}
    </View>
  );
}

function PhotoDot({
  slot,
  ms,
  typing,
  still,
  color,
}: {
  slot: 0 | 1 | 2;
  ms: SharedValue<number>;
  typing: boolean;
  still: boolean;
  color: string;
}) {
  const style = useAnimatedStyle(() => ({
    opacity: still ? 0.6 : avatarPhotoDot(slot, ms.value, typing),
  }));
  return (
    <Animated.View
      style={[
        {
          width: PHOTO_DOT.size,
          height: PHOTO_DOT.size,
          borderRadius: PHOTO_DOT.size / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}
