import { useLingui } from "@lingui/react/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import type { AvatarEyes, AvatarMotionMode, LogoAvatarActivity } from "@rakazo/core";
import {
  AVATAR_LID_CLOSE,
  AVATAR_MOTION_UNITS,
  AVATAR_TYPING_DOTS,
  avatarClip,
  avatarClock,
  avatarFrame,
  avatarIdentitySeed,
  avatarLifeState,
  avatarPokeFrame,
  avatarRestingBlink,
  avatarSchedulePose,
  avatarThinkingDot,
  avatarWorkingDot,
  botAvatarActivity,
  botEyeInk,
  isRunWorking,
  ORGANIC_AVATAR_EYES,
  ORGANIC_AVATAR_VIEWBOX,
  organicAvatarEyeTilt,
  organicAvatarPath,
  SHIPPED_BOT_AVATAR_EYES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  usesLogoAvatar,
} from "@rakazo/core";
import { memo, useEffect, useSyncExternalStore } from "react";
import { Image, Pressable, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { G, Path, Rect } from "react-native-svg";
import type { AvatarLife } from "../lib/avatar-life";
import { useAvatarOnScreen, useLife, usePoke, useSettling } from "../lib/avatar-life";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import { mobileLogoAvatarActivity } from "../lib/logo-avatar-activity";
import { useMobileTokens } from "../lib/native";
import { LogoAvatar } from "./logo-avatar";
import { NativeSymbol } from "./native-symbol";

const AnimatedRect = Animated.createAnimatedComponent(Rect);

/** How far (0–1) the face has turned into the typing dots, for a morph of 0–1. */
function morphGrow(morph: number): number {
  "worklet";
  const t = Math.min(Math.max(morph, 0), 1);
  return t * t * (3 - 2 * t);
}
/** The face shrinks until it is the size of the middle typing dot. */
const MORPH_SHRINK = 1 - (2 * AVATAR_TYPING_DOTS.radius) / AVATAR_MOTION_UNITS;
/** How many units wide a view box is. */
function viewBoxUnits(viewBox: string): number {
  return Number(viewBox.split(" ")[2]);
}

/** The avatar's flat frame right now, a tap poke included; a worklet. */
function liveFrame(life: AvatarLife) {
  "worklet";
  const now = life.seconds.value;
  const segments = life.schedule.value;
  const pose = avatarSchedulePose(segments, now);
  const frame = avatarFrame(pose, life.awake.value);
  if (life.awake.value < 1) {
    // Resting and Reduce Motion blinks: the authored blink times, with the resting blink.
    let shut = 0;
    for (const segment of segments) {
      if (!segment.clip || segment.start > now) continue;
      const clip = avatarClip(segment.clip);
      for (const blink of clip.blinks ?? [])
        shut = Math.max(shut, avatarRestingBlink(now - segment.start - blink));
    }
    frame.lid = Math.min(frame.lid, 1 - AVATAR_LID_CLOSE * shut);
  }
  const poke = life.poke.value;
  if (poke) {
    const extra = avatarPokeFrame(poke, life.pokeProgress.value);
    frame.rotate += extra.rotate;
    frame.translateY += extra.translateY;
    frame.scaleY *= extra.scaleY;
    frame.eyeY += extra.eyeY;
  }
  // The face shrinks into the middle typing dot while the bot writes.
  const grow = morphGrow(life.morph.value);
  frame.scaleX *= 1 - MORPH_SHRINK * grow;
  frame.scaleY *= 1 - MORPH_SHRINK * grow;
  return { frame, grow };
}

/** The body transform for an avatar `size` points wide. */
function useBodyStyle(life: AvatarLife, size: number) {
  return useAnimatedStyle(() => {
    const { frame, grow } = liveFrame(life);
    return {
      opacity: 1 - grow,
      transform: [
        { translateX: frame.translateX * size },
        { translateY: frame.translateY * size },
        { rotate: `${frame.rotate}deg` },
        { scaleX: frame.scaleX },
        { scaleY: frame.scaleY },
      ],
    };
  });
}

/** An eye's offset (motion units), its height and whether it shows. */
function eyeState(life: AvatarLife) {
  "worklet";
  const { frame, grow } = liveFrame(life);
  return { x: frame.eyeX, y: frame.eyeY, lid: frame.lid, hidden: grow >= 0.5 };
}

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  avatarSet?: BotAvatarSet;
  activity?: LogoAvatarActivity;
  muted?: boolean;
  motion?: AvatarMotionMode;
  composing?: boolean;
  pokeable?: boolean;
  /**
   * Shows the working dot exactly when true, fading and scaling it in and out, instead of
   * deriving it from `status` (the chat title passes whether its thread has a run at work).
   */
  workingDot?: boolean;
}

/** Missing set metadata deliberately preserves every existing avatar. */
export const BotAvatar = memo(function BotAvatar(props: BotAvatarProps) {
  if (usesLogoAvatar(props)) {
    return <RakazoBotAvatar {...props} />;
  }
  return <LegacyBotAvatar {...props} />;
});

function RakazoBotAvatar({
  color,
  identity,
  size = 54,
  status,
  activity,
  composing = false,
  muted = false,
  motion = "static",
  pokeable = false,
  workingDot,
}: BotAvatarProps) {
  const liveActivity = useSyncExternalStore(
    mobileLogoAvatarActivity.subscribe,
    () => mobileLogoAvatarActivity.getActivity(identity ?? "", status),
    (): LogoAvatarActivity => "idle",
  );
  const resolved = botAvatarActivity(
    { color, avatarSet: "rakazo" },
    activity ??
      (composing && (liveActivity === "working" || liveActivity === "idle")
        ? "writing"
        : liveActivity),
  );
  const working = isRunWorking(status) && resolved !== "writing" && motion !== "running";
  return (
    <View style={{ width: size, height: size }}>
      <LogoAvatar
        color={color}
        identity={identity}
        size={size}
        activity={resolved}
        motion={motion}
        pokeable={pokeable}
      />
      {workingDot !== undefined ? (
        <FadingWorkingDot visible={workingDot} size={size} muted={muted} />
      ) : working ? (
        <WorkingDot size={size} muted={muted} />
      ) : null}
      {muted ? <MutedBadge size={size} /> : null}
    </View>
  );
}

/** How long the chat title's working dot takes to appear and to go. */
const WORKING_DOT_IN_MS = 220;
const WORKING_DOT_OUT_MS = 180;

function workingDotStyle(size: number, muted: boolean, background: string, fill: string) {
  const dot = avatarWorkingDot(size);
  return {
    position: "absolute",
    right: muted ? undefined : dot.inset - dot.ring,
    left: muted ? dot.inset - dot.ring : undefined,
    bottom: dot.inset - dot.ring,
    width: dot.diameter + dot.ring * 2,
    height: dot.diameter + dot.ring * 2,
    borderRadius: size,
    borderWidth: dot.ring,
    borderColor: background,
    backgroundColor: fill,
  } as const;
}

/** The working dot that grows in when work starts and shrinks away when it stops. */
function FadingWorkingDot({
  visible,
  size,
  muted,
}: {
  visible: boolean;
  size: number;
  muted: boolean;
}) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const reducedMotion = useReducedMotion();
  // Mounts in its current state: only a change animates.
  const shown = useSharedValue(visible ? 1 : 0);
  useEffect(() => {
    shown.value = reducedMotion
      ? visible
        ? 1
        : 0
      : withTiming(visible ? 1 : 0, {
          duration: visible ? WORKING_DOT_IN_MS : WORKING_DOT_OUT_MS,
          easing: Easing.out(Easing.cubic),
        });
  }, [shown, visible, reducedMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scale: 0.4 + 0.6 * shown.value }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLabel={visible ? t`Working` : undefined}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      style={[workingDotStyle(size, muted, tokens.background, tokens.workingDot), style]}
    />
  );
}

function WorkingDot({ size, muted }: { size: number; muted: boolean }) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  return (
    <View
      accessibilityLabel={t`Working`}
      style={workingDotStyle(size, muted, tokens.background, tokens.workingDot)}
    />
  );
}

function MutedBadge({ size }: { size: number }) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  return (
    <View
      accessible
      accessibilityLabel={t`Notifications silenced`}
      style={{
        position: "absolute",
        right: -2,
        bottom: -2,
        width: Math.max(14, Math.round(size * 0.34)),
        height: Math.max(14, Math.round(size * 0.34)),
        borderRadius: size,
        borderWidth: 2,
        borderColor: tokens.background,
        // Opaque under the translucent fill, so the avatar does not show through the bell.
        backgroundColor: tokens.background,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          borderRadius: size,
          backgroundColor: tokens.secondary,
        }}
      />
      <NativeSymbol
        ios="bell.slash.fill"
        android="notifications-off"
        size={Math.max(8, Math.round(size * 0.17))}
        color={tokens.foreground}
      />
    </View>
  );
}

function LegacyBotAvatar({
  color,
  size = 54,
  status,
  identity,
  muted = false,
  motion = "static",
  composing = false,
  pokeable = false,
  workingDot,
}: {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  muted?: boolean;
  /**
   * How the avatar may move: still (the default), lazy (inbox rows and pinned chats: still
   * at rest, moving while the bot is busy), live (the call card: also blinks at rest) or
   * running (the activity mark in a chat).
   */
  motion?: AvatarMotionMode;
  /**
   * The bot is writing its reply: a moving avatar turns into the typing dots, and no avatar
   * shows the working dot.
   */
  composing?: boolean;
  /** A tap plays a little reaction (the activity mark). */
  pokeable?: boolean;
  workingDot?: boolean;
}) {
  const tokens = useMobileTokens();
  const state = avatarLifeState(status, composing);
  // The working dot marks a bot at work, not one writing its reply; a running avatar is
  // itself that sign, so it carries none.
  const isWorking = isRunWorking(status) && !composing && motion !== "running";
  const parsed = mobileBotAvatarPresentation(color);
  const fillColor = parsed.kind === "shape" || parsed.kind === "color" ? parsed.color : color;
  const eyeColor = botEyeInk(fillColor, tokens);
  const onScreen = useAvatarOnScreen();
  const reducedMotion = useReducedMotion();
  const settling = useSettling(state);
  const clock = avatarClock({
    mode: motion,
    onScreen,
    hasEyes: parsed.kind !== "image",
    size,
    state,
    settling,
    reducedMotion,
  });
  const life = useLife(state, clock, size, motion);
  const poke = usePoke(life, pokeable && clock === "running");
  const bodyStyle = useBodyStyle(life, size);
  const picture =
    parsed.kind === "image" && parsed.imageUrl ? (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: "hidden",
          // A plain circle holds the photo's place while it loads, or if it fails to.
          backgroundColor: tokens.secondary,
        }}
      >
        <Image source={{ uri: parsed.imageUrl }} style={{ width: size, height: size }} />
      </View>
    ) : parsed.kind === "shape" ? (
      <ShippedShapeAvatar
        color={parsed.color}
        eyeColor={eyeColor}
        shapePath={parsed.shapePath}
        size={size}
        life={life}
        bodyStyle={bodyStyle}
      />
    ) : (
      <OrganicAvatar
        color={fillColor}
        eyeColor={eyeColor}
        identity={identity}
        size={size}
        life={life}
        bodyStyle={bodyStyle}
      />
    );
  const avatar = (
    <View style={{ width: size, height: size }}>
      {picture}
      {parsed.kind !== "image" && clock !== "still" ? (
        <ThinkingDots color={fillColor} size={size} life={life} />
      ) : null}
      {workingDot !== undefined ? (
        <FadingWorkingDot visible={workingDot} size={size} muted={muted} />
      ) : isWorking ? (
        <WorkingDot size={size} muted={muted} />
      ) : null}
      {muted ? <MutedBadge size={size} /> : null}
    </View>
  );
  // A tap is a little toy, not an action, so it stays out of the accessibility tree.
  return pokeable ? (
    <Pressable accessible={false} onPress={poke}>
      {avatar}
    </Pressable>
  ) : (
    avatar
  );
}

/** The three typing dots a writing bot's avatar turns into; the middle one is its body. */
function ThinkingDots({ color, size, life }: { color: string; size: number; life: AvatarLife }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", width: size, height: size }}>
      <Dot slot={0} color={color} size={size} life={life} />
      <Dot slot={1} color={color} size={size} life={life} />
      <Dot slot={2} color={color} size={size} life={life} />
    </View>
  );
}

function Dot({
  slot,
  color,
  size,
  life,
}: {
  slot: 0 | 1 | 2;
  color: string;
  size: number;
  life: AvatarLife;
}) {
  const style = useAnimatedStyle(() => {
    const dot = avatarThinkingDot(slot, life.seconds.value, life.morph.value);
    const unit = size / AVATAR_MOTION_UNITS;
    const radius = dot.radius * unit;
    return {
      opacity: dot.opacity,
      width: radius * 2,
      height: radius * 2,
      borderRadius: radius,
      left: size / 2 + dot.x * unit - radius,
      top: size / 2 + dot.y * unit - radius,
    };
  });
  return <Animated.View style={[{ position: "absolute", backgroundColor: color }, style]} />;
}

type BodyStyle = ReturnType<typeof useAnimatedStyle>;

/** Bar eyes' live props: motion offsets scaled to the view box, closing about their centre. */
function useBarEyes(eyes: AvatarEyes, viewBox: string, life: AvatarLife) {
  const scale = viewBoxUnits(viewBox) / AVATAR_MOTION_UNITS;
  const eyeProps = (cx: number) => () => {
    "worklet";
    const state = eyeState(life);
    const height = state.hidden ? 0 : eyes.height * state.lid;
    return {
      x: cx - eyes.width / 2 + state.x * scale,
      y: eyes.cy - height / 2 + state.y * scale,
      height,
    };
  };
  return [useAnimatedProps(eyeProps(eyes.leftCx)), useAnimatedProps(eyeProps(eyes.rightCx))];
}

function ShippedShapeAvatar({
  color,
  eyeColor,
  shapePath,
  size,
  life,
  bodyStyle,
}: {
  color: string;
  eyeColor: string;
  shapePath: string;
  size: number;
  life: AvatarLife;
  bodyStyle: BodyStyle;
}) {
  const eyes = SHIPPED_BOT_AVATAR_EYES;
  const [leftEye, rightEye] = useBarEyes(eyes, SHIPPED_BOT_AVATAR_VIEWBOX, life);
  return (
    <Animated.View style={[{ width: size, height: size }, bodyStyle]}>
      <Svg width={size} height={size} viewBox={SHIPPED_BOT_AVATAR_VIEWBOX}>
        <Path d={shapePath} fill={color} />
        <G fill={eyeColor}>
          <AnimatedRect animatedProps={leftEye} width={eyes.width} rx={eyes.width / 2} />
          <AnimatedRect animatedProps={rightEye} width={eyes.width} rx={eyes.width / 2} />
        </G>
      </Svg>
    </Animated.View>
  );
}

function OrganicAvatar({
  color,
  eyeColor,
  identity,
  size,
  life,
  bodyStyle,
}: {
  color: string;
  eyeColor: string;
  identity?: string;
  size: number;
  life: AvatarLife;
  bodyStyle: BodyStyle;
}) {
  const seed = avatarIdentitySeed(identity || color || "#8B5CF6");
  const eyes = ORGANIC_AVATAR_EYES;
  const [leftEye, rightEye] = useBarEyes(eyes, ORGANIC_AVATAR_VIEWBOX, life);
  return (
    <Animated.View style={[{ width: size, height: size }, bodyStyle]}>
      <Svg width={size} height={size} viewBox={ORGANIC_AVATAR_VIEWBOX}>
        <Path d={organicAvatarPath(seed)} fill={color} />
        <G transform={`rotate(${organicAvatarEyeTilt(seed)})`}>
          {[leftEye, rightEye].map((props, index) => (
            <AnimatedRect
              key={index}
              animatedProps={props}
              width={eyes.width}
              rx={eyes.width / 2}
              fill={eyeColor}
            />
          ))}
        </G>
      </Svg>
    </Animated.View>
  );
}
