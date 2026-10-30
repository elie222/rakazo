import type { BotAvatarSet } from "@rakazo/contracts";
import type { AvatarMotionMode, LogoAvatarActivity } from "@rakazo/core";
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
  isRunWorking,
  organicAvatarPath,
  SHIPPED_BOT_AVATAR_CENTER,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  usesLogoAvatar,
} from "@rakazo/core";
import { botEyeColor } from "@rakazo/ui-tokens";
import { memo, useSyncExternalStore } from "react";
import { Image, Pressable, View } from "react-native";
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
} from "react-native-reanimated";
import Svg, { Ellipse, G, Path, Rect } from "react-native-svg";
import type { AvatarLife } from "../lib/avatar-life";
import { useAvatarOnScreen, useLife, usePoke, useSettling } from "../lib/avatar-life";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import { useI18n } from "../lib/i18n";
import { mobileLogoAvatarActivity } from "../lib/logo-avatar-activity";
import { useMobileTokens } from "../lib/native";
import { LogoAvatar } from "./logo-avatar";
import { NativeSymbol } from "./native-symbol";

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);

/** How far (0–1) the face has turned into the typing dots, for a morph of 0–1. */
function morphGrow(morph: number): number {
  "worklet";
  const t = Math.min(Math.max(morph, 0), 1);
  return t * t * (3 - 2 * t);
}
/** The face shrinks until it is the size of the middle typing dot. */
const MORPH_SHRINK = 1 - (2 * AVATAR_TYPING_DOTS.radius) / AVATAR_MOTION_UNITS;
/** The shipped shapes' view box is this many units wide. */
const SHAPE_UNITS = Number(SHIPPED_BOT_AVATAR_VIEWBOX.split(" ")[2]);

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
      {working ? <WorkingDot size={size} muted={muted} /> : null}
      {muted ? <MutedBadge size={size} /> : null}
    </View>
  );
}

function WorkingDot({ size, muted }: { size: number; muted: boolean }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const dot = avatarWorkingDot(size);
  return (
    <View
      accessibilityLabel={t("Working")}
      style={{
        position: "absolute",
        right: muted ? undefined : dot.inset - dot.ring,
        left: muted ? dot.inset - dot.ring : undefined,
        bottom: dot.inset - dot.ring,
        width: dot.diameter + dot.ring * 2,
        height: dot.diameter + dot.ring * 2,
        borderRadius: size,
        borderWidth: dot.ring,
        borderColor: tokens.background,
        backgroundColor: tokens.workingDot,
      }}
    />
  );
}

function MutedBadge({ size }: { size: number }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  return (
    <View
      accessible
      accessibilityLabel={t("Notifications silenced")}
      style={{
        position: "absolute",
        right: -2,
        bottom: -2,
        width: Math.max(14, Math.round(size * 0.34)),
        height: Math.max(14, Math.round(size * 0.34)),
        borderRadius: size,
        borderWidth: 2,
        borderColor: tokens.background,
        backgroundColor: tokens.secondary,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
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
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const state = avatarLifeState(status, composing);
  // The working dot marks a bot at work, not one writing its reply; a running avatar is
  // itself that sign, so it carries none.
  const isWorking = isRunWorking(status) && !composing && motion !== "running";
  const parsed = mobileBotAvatarPresentation(color);
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
  const fillColor = parsed.kind === "shape" || parsed.kind === "color" ? parsed.color : color;
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
        eyeColor={parsed.eyeColor}
        shapePath={parsed.shapePath}
        size={size}
        life={life}
        bodyStyle={bodyStyle}
      />
    ) : (
      <OrganicAvatar
        color={fillColor}
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
      {isWorking ? <WorkingDot size={size} muted={muted} /> : null}
      {muted ? (
        <View
          accessible
          accessibilityLabel={t("Notifications silenced")}
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(14, Math.round(size * 0.34)),
            height: Math.max(14, Math.round(size * 0.34)),
            borderRadius: size,
            borderWidth: 2,
            borderColor: "#000",
            backgroundColor: "#242428",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <NativeSymbol
            ios="bell.slash.fill"
            android="notifications-off"
            size={Math.max(8, Math.round(size * 0.17))}
            color="#ECECEE"
          />
        </View>
      ) : null}
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
  const center = SHIPPED_BOT_AVATAR_CENTER;
  // Offsets are in motion units, scaled to the shape's view box.
  const eyeProps = (cx: number) => () => {
    "worklet";
    const state = eyeState(life);
    const scale = SHAPE_UNITS / AVATAR_MOTION_UNITS;
    return {
      cx: cx + state.x * scale,
      cy: center - 8 + state.y * scale,
      ry: state.hidden ? 0 : 7 * state.lid,
    };
  };
  const leftEye = useAnimatedProps(eyeProps(center - 29));
  const rightEye = useAnimatedProps(eyeProps(center + 29));
  return (
    <Animated.View style={[{ width: size, height: size }, bodyStyle]}>
      <Svg width={size} height={size} viewBox={SHIPPED_BOT_AVATAR_VIEWBOX}>
        <Path d={shapePath} fill={color} />
        <G fill={eyeColor}>
          <AnimatedEllipse animatedProps={leftEye} rx={10} />
          <AnimatedEllipse animatedProps={rightEye} rx={10} />
        </G>
      </Svg>
    </Animated.View>
  );
}

function OrganicAvatar({
  color,
  identity,
  size,
  life,
  bodyStyle,
}: {
  color: string;
  identity?: string;
  size: number;
  life: AvatarLife;
  bodyStyle: BodyStyle;
}) {
  const seed = avatarIdentitySeed(identity || color || "#8B5CF6");
  // Offsets are in motion units, scaled to this 120-unit box; eyes close about their centre.
  const eyeProps = (x: number) => () => {
    "worklet";
    const state = eyeState(life);
    const scale = 120 / AVATAR_MOTION_UNITS;
    const height = state.hidden ? 0 : 24 * state.lid;
    return { x: x + state.x * scale, y: -height / 2 + state.y * scale, height };
  };
  const leftEyeProps = useAnimatedProps(eyeProps(-14));
  const rightEyeProps = useAnimatedProps(eyeProps(7));
  return (
    <Animated.View style={[{ width: size, height: size }, bodyStyle]}>
      <Svg width={size} height={size} viewBox="-60 -60 120 120">
        <Path d={organicAvatarPath(seed)} fill={color} />
        <G transform={`rotate(${(seed % 9) - 4})`}>
          <AnimatedRect animatedProps={leftEyeProps} width={7} rx={3.5} fill={botEyeColor} />
          <AnimatedRect animatedProps={rightEyeProps} width={7} rx={3.5} fill={botEyeColor} />
        </G>
      </Svg>
    </Animated.View>
  );
}
