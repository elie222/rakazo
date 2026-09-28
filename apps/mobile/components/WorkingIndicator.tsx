import { useEffect } from "react";
import { View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

const CYCLE_MS = 1100;
const DOTS = [0, 1, 2];

function Dot({
  progress,
  offset,
  color,
  size,
  still,
}: {
  progress: SharedValue<number>;
  offset: number;
  color: string;
  size: number;
  still: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (still) return { opacity: 0.55, transform: [{ scale: 1 }] };
    const phase = (progress.value + offset) % 1;
    return {
      opacity: interpolate(phase, [0, 0.5, 1], [0.25, 1, 0.25]),
      transform: [{ scale: interpolate(phase, [0, 0.5, 1], [0.85, 1.15, 0.85]) }],
    };
  });
  return (
    <Animated.View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

/**
 * A bot is working: dots pulsing in sequence, matching the web's shimmer moment.
 * `compact` is a single dot for list rows — decorative there, so the row's own
 * accessibility label carries the state instead.
 */
export function WorkingIndicator({ compact = false, tint }: { compact?: boolean; tint?: string }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) return;
    progress.value = withRepeat(
      withTiming(1, { duration: CYCLE_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [progress, reducedMotion]);

  if (compact) {
    return (
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Dot
          progress={progress}
          offset={0}
          size={8}
          still={reducedMotion}
          color={tint || tokens.mutedForeground}
        />
      </View>
    );
  }
  return (
    <View
      accessibilityLabel={t("Working…")}
      accessibilityRole="text"
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: tokens.muted,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: 20,
      }}
    >
      {DOTS.map((index) => (
        <Dot
          key={index}
          progress={progress}
          offset={index / DOTS.length}
          size={7}
          still={reducedMotion}
          color={tokens.mutedForeground}
        />
      ))}
    </View>
  );
}
