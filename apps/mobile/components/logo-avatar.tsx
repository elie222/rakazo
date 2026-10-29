import type { AvatarMotionMode, AvatarPoke, LogoAvatarActivity } from "@rakazo/core";
import {
  avatarPokeFrame,
  contrastRatio,
  LOGO_BODY_PATH,
  LOGO_LEFT_HAND_PATH,
  LOGO_RIGHT_HAND_PATH,
  LOGO_AVATAR_LIGHTING as lighting,
  logoAvatarFrame,
  logoAvatarPaint,
  logoAvatarTraits,
} from "@rakazo/core";
import { botEyeColor } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { useEffect, useId, useMemo } from "react";
import { Pressable } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import Svg, {
  ClipPath,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Mask,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { useAvatarOnScreen, usePoke } from "../lib/avatar-life";
import { useLogoAvatarClock } from "../lib/logo-avatar-clock";
import { useMobileTokens } from "../lib/native";

const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

/** Native SVG renderer: paths/gradients only, driven by shared deterministic motion. */
export function LogoAvatar({
  color,
  identity,
  size,
  activity,
  motion,
  pokeable = false,
}: {
  color: string;
  identity?: string;
  size: number;
  activity: LogoAvatarActivity;
  motion: AvatarMotionMode;
  pokeable?: boolean;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tokens = useMobileTokens();
  const traits = useMemo(
    () => logoAvatarTraits(identity || color || "default", color),
    [identity, color],
  );
  const paint = useMemo(
    () => logoAvatarPaint(traits.color, traits.originalOrange),
    [traits.color, traits.originalOrange],
  );
  const reduced = useReducedMotion();
  const onScreen = useAvatarOnScreen();
  const canMove = size >= 24 && motion !== "static" && (motion !== "lazy" || activity !== "idle");
  const milliseconds = useLogoAvatarClock(canMove && onScreen && !reduced);
  const frame = useDerivedValue(() =>
    logoAvatarFrame(activity, traits, milliseconds.value, reduced || !canMove),
  );
  // SVG's native host consumes six-value matrices; no JS transform extraction per frame.
  const body = useAnimatedProps(() => ({
    opacity: 1,
    matrix: [
      frame.value.bodyScale,
      0,
      0,
      frame.value.bodyScale,
      50 * (1 - frame.value.bodyScale),
      frame.value.bodyY + 84 * (1 - frame.value.bodyScale),
    ],
  }));
  const eyeInk =
    contrastRatio(traits.color, botEyeColor) >= 3.5
      ? botEyeColor
      : contrastRatio(traits.color, tokens.foreground) >=
          contrastRatio(traits.color, tokens.background)
        ? tokens.foreground
        : tokens.background;
  const leftEye = useAnimatedProps(() => ({
    cx: 40.5 + frame.value.eyeX,
    cy: 49 + frame.value.eyeY,
    ry: 8 * frame.value.lid * frame.value.blink,
  }));
  const rightEye = useAnimatedProps(() => ({
    cx: 59.5 + frame.value.eyeX,
    cy: 49 + frame.value.eyeY,
    ry: 8 * frame.value.lid * frame.value.blink,
  }));
  const page = useAnimatedProps(() => ({
    opacity: 1,
    matrix: [1, 0, 0, 1, frame.value.pageX, frame.value.pageY],
  }));
  const keyLeft = useAnimatedProps(() => ({
    opacity: frame.value.keyLeft,
    matrix: [1, 0, 0, 1, 0, frame.value.keyLeftY],
  }));
  const keyRight = useAnimatedProps(() => ({
    opacity: frame.value.keyRight,
    matrix: [1, 0, 0, 1, 0, frame.value.keyRightY],
  }));
  const pointer = useAnimatedProps(() => ({
    opacity: 1,
    matrix: [1, 0, 0, 1, frame.value.pointerX, frame.value.pointerY],
  }));
  const selection = useAnimatedProps(() => ({ opacity: frame.value.selection }));
  const stroke = Math.max(2.4, 100 / Math.max(1, size));
  const compact = size <= 38;
  const artwork = (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessible={false}>
      <Defs>
        <ClipPath id={`plate-${id}`}>
          <Rect width={100} height={100} rx={23} />
        </ClipPath>
        <ClipPath id={`body-${id}`}>
          <Path d={LOGO_BODY_PATH} />
        </ClipPath>
        <RadialGradient id={`fill-${id}`} {...lighting.body}>
          <Stop stopColor={paint.base} />
          <Stop offset=".48" stopColor={paint.base} />
          <Stop offset="1" stopColor={paint.edge} />
        </RadialGradient>
        <RadialGradient id={`shade-${id}`} {...lighting.flank}>
          <Stop stopColor={paint.flank} stopOpacity=".94" />
          <Stop offset=".4" stopColor={paint.flank} stopOpacity=".94" />
          <Stop offset=".65" stopColor={paint.flank} stopOpacity=".76" />
          <Stop offset=".85" stopColor={paint.flank} stopOpacity=".22" />
          <Stop offset="1" stopColor={paint.flank} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient
          id={`light-${id}`}
          gradientUnits={lighting.crown.gradientUnits}
          cx={lighting.crown.cx}
          cy={lighting.crown.cy}
          r={lighting.crown.r}
          gradientTransform={lighting.crown.gradientTransform}
        >
          <Stop stopColor="white" stopOpacity={lighting.crown.peak} />
          <Stop offset=".4" stopColor="white" stopOpacity={lighting.crown.shoulder} />
          <Stop offset="1" stopColor="white" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id={`left-${id}`} {...lighting.leftHand}>
          <Stop stopColor={paint.base} />
          <Stop offset=".28" stopColor={paint.base} />
          <Stop offset="1" stopColor={paint.shadow} />
        </RadialGradient>
        <RadialGradient id={`right-${id}`} {...lighting.rightHand}>
          <Stop stopColor={paint.base} />
          <Stop offset=".28" stopColor={paint.base} />
          <Stop offset="1" stopColor={paint.shadow} />
        </RadialGradient>
        <RadialGradient
          id={`left-light-${id}`}
          {...lighting.leftHand}
          r={lighting.handLight.radius}
        >
          <Stop stopColor="white" stopOpacity={lighting.handLight.leftPeak} />
          <Stop offset="1" stopColor="white" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient
          id={`right-light-${id}`}
          {...lighting.rightHand}
          r={lighting.handLight.radius}
        >
          <Stop stopColor="white" stopOpacity={lighting.handLight.rightPeak} />
          <Stop offset="1" stopColor="white" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id={`left-contact-${id}`} {...lighting.leftContact}>
          <Stop stopColor={paint.contact} stopOpacity=".72" />
          <Stop offset=".45" stopColor={paint.contact} stopOpacity=".64" />
          <Stop offset=".65" stopColor={paint.contact} stopOpacity=".3" />
          <Stop offset=".9" stopColor={paint.contact} stopOpacity=".04" />
          <Stop offset="1" stopColor={paint.contact} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id={`right-contact-${id}`} {...lighting.rightContact}>
          <Stop stopColor={paint.contact} stopOpacity=".72" />
          <Stop offset=".45" stopColor={paint.contact} stopOpacity=".64" />
          <Stop offset=".65" stopColor={paint.contact} stopOpacity=".3" />
          <Stop offset=".9" stopColor={paint.contact} stopOpacity=".04" />
          <Stop offset="1" stopColor={paint.contact} stopOpacity="0" />
        </RadialGradient>
        <LinearGradient
          id={`rim-direction-${id}`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="100"
          y2="0"
        >
          <Stop stopColor="white" stopOpacity=".25" />
          <Stop offset=".5" stopColor="white" stopOpacity=".72" />
          <Stop offset="1" stopColor="white" />
        </LinearGradient>
        <LinearGradient
          id={`rim-lower-fade-${id}`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2="100"
        >
          <Stop stopColor="white" stopOpacity="0" />
          <Stop offset=".36" stopColor="white" stopOpacity="0" />
          <Stop offset=".58" stopColor="white" />
          <Stop offset="1" stopColor="white" />
        </LinearGradient>
        <LinearGradient
          id={`rim-upper-cut-${id}`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2="100"
        >
          <Stop stopColor="black" stopOpacity="0" />
          <Stop offset=".36" stopColor="black" stopOpacity="0" />
          <Stop offset=".58" stopColor="black" />
          <Stop offset="1" stopColor="black" />
        </LinearGradient>
        <Mask
          id={`rim-upper-mask-${id}`}
          maskUnits="userSpaceOnUse"
          maskType="luminance"
          x="0"
          y="0"
          width="100"
          height="110"
        >
          <Rect width="100" height="110" fill={`url(#rim-direction-${id})`} />
          <Rect width="100" height="110" fill={`url(#rim-upper-cut-${id})`} />
          <Rect width="100" height="110" fill={`url(#rim-left-trim-${id})`} />
        </Mask>
        <Mask
          id={`rim-lower-mask-${id}`}
          maskUnits="userSpaceOnUse"
          maskType="luminance"
          x="0"
          y="0"
          width="100"
          height="110"
        >
          <Rect width="100" height="110" fill={`url(#rim-lower-fade-${id})`} />
        </Mask>
        <RadialGradient id={`rim-left-trim-${id}`} {...lighting.rimLeftTrim}>
          <Stop stopColor="black" stopOpacity=".6" />
          <Stop offset=".9" stopColor="black" stopOpacity=".6" />
          <Stop offset=".94" stopColor="black" stopOpacity=".5" />
          <Stop offset=".965" stopColor="black" stopOpacity="0" />
          <Stop offset="1" stopColor="black" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id={`rim-upper-${id}`} {...lighting.rimUpper}>
          <Stop stopColor={paint.rim} stopOpacity="0" />
          <Stop offset=".818" stopColor={paint.rim} stopOpacity="0" />
          <Stop offset=".855" stopColor={paint.rim} stopOpacity=".035" />
          <Stop offset=".882" stopColor={paint.rim} stopOpacity=".14" />
          <Stop offset=".9" stopColor={paint.rim} stopOpacity=".42" />
          <Stop offset=".918" stopColor={paint.rim} stopOpacity=".53" />
          <Stop offset=".941" stopColor={paint.rim} stopOpacity=".2" />
          <Stop offset=".973" stopColor={paint.rim} stopOpacity="0" />
          <Stop offset="1" stopColor={paint.rim} stopOpacity="0" />
        </RadialGradient>
        {(["Left", "Right"] as const).map((side) => (
          <RadialGradient
            key={side}
            id={`rim-${side.toLowerCase()}-${id}`}
            {...lighting[side === "Left" ? "rimLeft" : "rimRight"]}
          >
            <Stop stopColor={paint.rim} stopOpacity="0" />
            <Stop offset=".873" stopColor={paint.rim} stopOpacity="0" />
            <Stop offset=".891" stopColor={paint.rim} stopOpacity={side === "Left" ? 0.22 : 0.46} />
            <Stop offset=".912" stopColor={paint.rim} stopOpacity={side === "Left" ? 0.22 : 0.46} />
            <Stop offset=".93" stopColor={paint.rim} stopOpacity={side === "Left" ? 0.1 : 0.2} />
            <Stop offset=".955" stopColor={paint.rim} stopOpacity="0" />
            <Stop offset="1" stopColor={paint.rim} stopOpacity="0" />
          </RadialGradient>
        ))}
        <ClipPath id={`pages-${id}`}>
          <Path d="M26 79Q37 75 47 80V91Q37 87 26 91ZM53 80Q63 75 74 79V91Q63 87 53 91Z" />
        </ClipPath>
        <ClipPath id={`keys-${id}`}>
          <Rect x={26} y={78} width={48} height={16} rx={1} />
        </ClipPath>
        <ClipPath id={`screen-${id}`}>
          <Rect x={25} y={74.5} width={50} height={20} rx={1} />
        </ClipPath>
      </Defs>
      <G clipPath={`url(#plate-${id})`}>
        <Rect width={100} height={100} rx={23} fill={tokens.sidebar} />
        <AnimatedG animatedProps={body}>
          <G transform="translate(0 9)">
            <Path d={LOGO_BODY_PATH} fill={`url(#fill-${id})`} />
            <Path d={LOGO_BODY_PATH} fill={`url(#shade-${id})`} />
            <Path d={LOGO_BODY_PATH} fill={`url(#light-${id})`} />
            <G clipPath={`url(#body-${id})`}>
              <Path
                d={LOGO_BODY_PATH}
                fill={`url(#rim-upper-${id})`}
                mask={`url(#rim-upper-mask-${id})`}
              />
              <G mask={`url(#rim-lower-mask-${id})`}>
                <Path d={LOGO_BODY_PATH} fill={`url(#rim-left-${id})`} />
                <Path d={LOGO_BODY_PATH} fill={`url(#rim-right-${id})`} />
              </G>

              <Path d={LOGO_BODY_PATH} fill={`url(#left-contact-${id})`} />
              <Path d={LOGO_BODY_PATH} fill={`url(#right-contact-${id})`} />
              <Path d={LOGO_LEFT_HAND_PATH} fill={`url(#left-${id})`} />
              <Path d={LOGO_RIGHT_HAND_PATH} fill={`url(#right-${id})`} />
              <Path d={LOGO_LEFT_HAND_PATH} fill={`url(#left-light-${id})`} />
              <Path d={LOGO_RIGHT_HAND_PATH} fill={`url(#right-light-${id})`} />
            </G>
          </G>
          <AnimatedEllipse animatedProps={leftEye} rx={5.2} fill={eyeInk} />
          <AnimatedEllipse animatedProps={rightEye} rx={5.2} fill={eyeInk} />
          {size >= 24 ? (
            <G
              fill="none"
              stroke={tokens.foreground}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {activity === "reading" ? (
                <>
                  <Path
                    d="M22 76Q36 71 50 77Q64 71 78 76V96Q64 91 50 97Q36 91 22 96Z"
                    fill={tokens.background}
                  />
                  <Path d="M50 77V97" />
                  <G clipPath={`url(#pages-${id})`}>
                    <Path d="M28 84H43M57 84H72" opacity=".8" />
                    {!compact ? <AnimatedPath animatedProps={page} d="M27 81.5H36" /> : null}
                  </G>
                </>
              ) : null}
              {activity === "writing" ? (
                <>
                  <Rect x={22} y={75} width={56} height={22} rx={3} fill={tokens.background} />
                  <G clipPath={`url(#keys-${id})`}>
                    <AnimatedPath animatedProps={keyLeft} d="M29 82H35M40 82H46" />
                    <AnimatedPath animatedProps={keyRight} d="M54 82H60M65 82H71" />
                    <Path d="M36 90H64" opacity=".85" />
                  </G>
                </>
              ) : null}
              {activity === "computer" ? (
                <>
                  <Rect x={22} y={72} width={56} height={24} rx={3} fill={tokens.background} />
                  {!compact ? <Path d="M47 96V98M39 98H61" /> : null}
                  <G clipPath={`url(#screen-${id})`}>
                    {!compact ? (
                      <AnimatedRect
                        animatedProps={selection}
                        x={53}
                        y={80}
                        width={16}
                        height={11}
                        rx={1}
                      />
                    ) : null}
                    <G transform="translate(31 75)">
                      <AnimatedG animatedProps={pointer}>
                        <Path
                          d="M0 0V14L3.5 10.5L8 16L11 14L7 8.5L14 7Z"
                          fill={tokens.foreground}
                          stroke="none"
                        />
                      </AnimatedG>
                    </G>
                  </G>
                </>
              ) : null}
            </G>
          ) : null}
        </AnimatedG>
      </G>
      <Rect width={100} height={100} rx={23} fill="none" stroke={tokens.border} strokeWidth={1} />
    </Svg>
  );
  return pokeable ? (
    <PokeableLogoAvatar enabled={canMove && onScreen && !reduced} size={size}>
      {artwork}
    </PokeableLogoAvatar>
  ) : (
    artwork
  );
}

/** Reuse the existing tap clips without allocating a second continuous clock. */
function PokeableLogoAvatar({
  enabled,
  size,
  children,
}: {
  enabled: boolean;
  size: number;
  children: ReactNode;
}) {
  const poke = useSharedValue<AvatarPoke | null>(null);
  const pokeProgress = useSharedValue(1);
  const play = usePoke({ poke, pokeProgress }, enabled);
  const style = useAnimatedStyle(() => {
    const extra = poke.value ? avatarPokeFrame(poke.value, pokeProgress.value) : null;
    return {
      transform: [
        { translateY: (extra?.translateY ?? 0) * size },
        { rotate: `${extra?.rotate ?? 0}deg` },
        { scaleY: extra?.scaleY ?? 1 },
      ],
    };
  });
  useEffect(() => {
    if (!enabled) {
      cancelAnimation(pokeProgress);
      poke.value = null;
      pokeProgress.value = 1;
    }
    return () => cancelAnimation(pokeProgress);
  }, [enabled, poke, pokeProgress]);
  // Like the original avatar, this is a visual toy rather than an accessible action.
  return (
    <Pressable accessible={false} onPress={play}>
      <Animated.View style={style}>{children}</Animated.View>
    </Pressable>
  );
}
