import { useEffect, useRef } from "react";
import { Animated, View } from "react-native";

export function BotAvatar({
  color,
  size = 54,
  thinking = false,
}: {
  color: string;
  size?: number;
  thinking?: boolean;
}) {
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.4);
  const dot = Math.max(3, Math.round(size * 0.1));
  const gap = Math.max(4, Math.round(size * 0.13));
  const bob = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!thinking) {
      bob.setValue(0);
      blink.setValue(1);
      return;
    }
    const motion = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(bob, { toValue: 1, duration: 520, useNativeDriver: true }),
          Animated.timing(bob, { toValue: 0, duration: 520, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.delay(900),
          Animated.timing(blink, { toValue: 0.2, duration: 90, useNativeDriver: true }),
          Animated.timing(blink, { toValue: 1, duration: 90, useNativeDriver: true }),
        ]),
      ]),
    );
    motion.start();
    return () => motion.stop();
  }, [thinking, bob, blink]);

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        alignItems: "center",
        justifyContent: "center",
        transform: [
          {
            translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }),
          },
        ],
      }}
    >
      <View
        style={{
          width: visorW,
          height: visorH,
          borderRadius: Math.round(visorH * 0.55),
          backgroundColor: "rgba(12,12,14,0.78)",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap,
        }}
      >
        <Animated.View
          style={{
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: "#fff",
            opacity: blink,
            transform: [{ scaleY: blink }],
          }}
        />
        <Animated.View
          style={{
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: "#fff",
            opacity: blink,
            transform: [{ scaleY: blink }],
          }}
        />
      </View>
    </Animated.View>
  );
}
