import { View } from "react-native";

export function BotAvatar({
  color,
  size = 54,
  status,
  working,
}: {
  color: string;
  size?: number;
  status?: string;
  working?: boolean;
}) {
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.44);
  const eyeW = Math.max(3, Math.round(size * 0.11));
  const eyeH = Math.max(4, Math.round(size * 0.17));
  const gap = Math.max(3, Math.round(size * 0.11));
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: visorW,
          height: visorH,
          borderRadius: Math.round(visorH * 0.52),
          backgroundColor: "#0C0C0E",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap,
        }}
      >
        <View
          style={{
            width: eyeW,
            height: eyeH,
            borderRadius: Math.max(2, Math.round(eyeW * 0.6)),
            backgroundColor: "#fff",
          }}
        />
        <View
          style={{
            width: eyeW,
            height: eyeH,
            borderRadius: Math.max(2, Math.round(eyeW * 0.6)),
            backgroundColor: "#fff",
          }}
        />
      </View>
    </View>
  );
}
