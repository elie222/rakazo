import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { StyleProp, TextStyle } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/** One pass of the glint, matching the web shimmer. */
const SWEEP_MS = 1400;
/** The glint is this share of the text's width, brightest in the middle. */
const BAND = 0.6;
const SLICES = [0.2, 0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45, 0.2];

/**
 * A single line of text with a highlight sweeping left to right across it, like the web's
 * shimmer: the text in `color`, glinting toward `highlight`. Without React Native gradient
 * masks, the glint is the same line in `highlight` seen through a few narrow windows that
 * fade in toward the middle. Still while `paused` or with Reduce Motion.
 */
export function ShimmerText({
  children,
  style,
  color,
  highlight,
  paused = false,
  maxFontSizeMultiplier,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  color: string;
  highlight: string;
  paused?: boolean;
  maxFontSizeMultiplier?: number;
}) {
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const progress = useSharedValue(0);
  const running = !reducedMotion && !paused && width > 0;

  useEffect(() => {
    if (!running) return;
    progress.value = 0;
    progress.value = withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }), -1);
    return () => cancelAnimation(progress);
  }, [running, progress]);

  const textStyle = [style, { color: highlight }];
  return (
    <View style={{ flexShrink: 1 }}>
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={maxFontSizeMultiplier}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[style, { color }]}
      >
        {children}
      </Text>
      {running ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={StyleSheet.absoluteFill}
        >
          {SLICES.map((opacity, index) => (
            <ShimmerSlice
              key={index}
              index={index}
              opacity={opacity}
              width={width}
              progress={progress}
            >
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={maxFontSizeMultiplier}
                style={[textStyle, { width }]}
              >
                {children}
              </Text>
            </ShimmerSlice>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** One window onto the bright copy; the copy moves against it so it stays over the line. */
function ShimmerSlice({
  index,
  opacity,
  width,
  progress,
  children,
}: {
  index: number;
  opacity: number;
  width: number;
  progress: SharedValue<number>;
  children: ReactNode;
}) {
  const sliceWidth = (width * BAND) / SLICES.length;
  // The band starts just off the leading edge and ends just past the trailing one.
  const left = useAnimatedStyle(() => {
    const x = -width * BAND + progress.value * width * (1 + BAND) + index * sliceWidth;
    return { transform: [{ translateX: x }] };
  });
  const back = useAnimatedStyle(() => {
    const x = -width * BAND + progress.value * width * (1 + BAND) + index * sliceWidth;
    return { transform: [{ translateX: -x }] };
  });
  return (
    <Animated.View
      style={[
        { position: "absolute", top: 0, bottom: 0, width: sliceWidth, overflow: "hidden", opacity },
        left,
      ]}
    >
      <Animated.View style={back}>{children}</Animated.View>
    </Animated.View>
  );
}
