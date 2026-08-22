import { View } from "react-native";

export function BotAvatar({ color, size = 54 }: { color: string; size?: number }) {
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.4);
  const dot = Math.max(3, Math.round(size * 0.1));
  const gap = Math.max(4, Math.round(size * 0.13));
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * 0.24)),
        backgroundColor: color,
        alignItems: "center",
        justifyContent: "center",
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
        <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: "#fff" }} />
        <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: "#fff" }} />
      </View>
    </View>
  );
}
