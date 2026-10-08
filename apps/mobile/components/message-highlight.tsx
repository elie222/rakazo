import { useEffect, useRef } from "react";
import { Animated, StyleSheet } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { mobileTokens } from "../lib/appearance";

/** An inset tint on the bubble, independent of the row and its separator. */
export function MessageHighlight({ active }: { active: boolean }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    opacity.setValue(active ? 0.08 : 0);
    if (!active || reducedMotion) return;
    const animation = Animated.sequence([
      Animated.delay(600),
      Animated.timing(opacity, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [active, opacity, reducedMotion]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { borderRadius: 20, backgroundColor: mobileTokens().foreground, opacity },
      ]}
    />
  );
}
