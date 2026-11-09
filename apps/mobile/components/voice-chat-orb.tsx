/**
 * The voice chat orb: a large gradient ball whose colour, size and pulse
 * follow the conversation. Three states, each with its own look:
 *
 * - waiting: cool blue-green, slow breathing, slow ring;
 * - user: warm amber-red while the caller's words come in, fast and large;
 * - ai: green-blue while the reply plays, in between.
 *
 * State changes cross-fade the gradients and ease the size over half a
 * second, so nothing jumps. The breathing loop itself never restarts — only
 * the ring takes the new rhythm — so a switch mid-breath stays smooth.
 */

import { useEffect, useRef } from "react";
import { Animated, View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { useMobileTokens } from "../lib/native";
import type { VoiceChatOrbVariant } from "../lib/voice-chat";

const VARIANTS: VoiceChatOrbVariant[] = ["waiting", "user", "ai"];

/** Target size and ring rhythm per state. */
const VARIANT_STYLE: Record<VoiceChatOrbVariant, { energy: number; ringMs: number }> = {
  waiting: { energy: 0, ringMs: 2600 },
  user: { energy: 1, ringMs: 900 },
  ai: { energy: 0.55, ringMs: 1500 },
};

/** Gradient stops per state, from the semantic tokens: no hardcoded hues. */
function variantColors(tokens: ReturnType<typeof useMobileTokens>) {
  return {
    waiting: { inner: tokens.link, outer: tokens.success },
    user: { inner: tokens.warning, outer: tokens.destructive },
    ai: { inner: tokens.success, outer: tokens.link },
  } as Record<VoiceChatOrbVariant, { inner: string; outer: string }>;
}

export function VoiceChatOrb({
  variant,
  size = 220,
  reducedMotion,
}: {
  variant: VoiceChatOrbVariant;
  size?: number;
  reducedMotion?: boolean;
}) {
  const tokens = useMobileTokens();
  const colors = variantColors(tokens);
  // 0 while waiting, 1 while the caller speaks, eased between states.
  const energy = useRef(new Animated.Value(0)).current;
  // One slow breath that never restarts, so a state change cannot pop it.
  const breath = useRef(new Animated.Value(0)).current;
  // The ring's sweep, restarted per state for its rhythm.
  const ring = useRef(new Animated.Value(0)).current;
  const fades = useRef({
    waiting: new Animated.Value(1),
    user: new Animated.Value(0),
    ai: new Animated.Value(0),
  }).current;

  useEffect(() => {
    const style = VARIANT_STYLE[variant];
    if (reducedMotion) {
      energy.setValue(style.energy);
    } else {
      Animated.timing(energy, {
        toValue: style.energy,
        duration: 500,
        useNativeDriver: true,
      }).start();
    }
    for (const key of VARIANTS) {
      Animated.timing(fades[key], {
        toValue: key === variant ? 1 : 0,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }
    if (reducedMotion) return;
    ring.setValue(0);
    const sweep = Animated.loop(
      Animated.timing(ring, { toValue: 1, duration: style.ringMs, useNativeDriver: true }),
    );
    sweep.start();
    return () => sweep.stop();
  }, [variant, reducedMotion, energy, ring, fades]);

  useEffect(() => {
    if (reducedMotion) {
      breath.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: 1200, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, breath]);

  const energyScale = energy.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const breathScale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });
  const ringScale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const ringOpacity = ring.interpolate({
    inputRange: [0, 0.7, 1],
    outputRange: [0.5, 0.15, 0],
  });

  return (
    <View
      accessible={false}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      {reducedMotion ? null : (
        <Animated.View
          style={{
            position: "absolute",
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1.5,
            borderColor: tokens.foreground,
            opacity: ringOpacity,
            transform: [{ scale: ringScale }],
          }}
        />
      )}
      <Animated.View style={{ transform: [{ scale: energyScale }] }}>
        <Animated.View style={{ transform: [{ scale: breathScale }] }}>
          {VARIANTS.map((key, index) => (
            <Animated.View
              key={key}
              style={{
                ...(index === 0
                  ? null
                  : { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }),
                opacity: fades[key],
              }}
            >
              <Svg width={size} height={size}>
                <Defs>
                  <RadialGradient id={`voice-orb-${key}`} cx="50%" cy="42%" r="65%">
                    <Stop offset="0%" stopColor={colors[key].inner} />
                    <Stop offset="60%" stopColor={colors[key].inner} />
                    <Stop offset="100%" stopColor={colors[key].outer} />
                  </RadialGradient>
                </Defs>
                <Circle cx="50%" cy="50%" r="48%" fill={`url(#voice-orb-${key})`} />
              </Svg>
            </Animated.View>
          ))}
        </Animated.View>
      </Animated.View>
    </View>
  );
}
