import type { AvatarStyle } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, avatarIdentitySeed, organicAvatarPath } from "@rakazo/core";
import { memo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { useAvatarStyle } from "./avatar-style";

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 54,
  status,
  identity,
  variant,
}: {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  variant?: AvatarStyle;
}) {
  const isWorking = ACTIVE_RUN_STATUSES.some((activeStatus) => activeStatus === status);
  const { avatarStyle } = useAvatarStyle();
  if ((variant ?? avatarStyle) === "organic") {
    const seed = avatarIdentitySeed(identity || color || "#8B5CF6");
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: isWorking ? 2 : 0,
          borderColor: "#FFFFFF",
        }}
      >
        <Svg width={size} height={size} viewBox="-60 -60 120 120">
          <Path d={organicAvatarPath(seed)} fill={color} />
          <Rect
            x={-14}
            y={-12}
            width={7}
            height={24}
            rx={3.5}
            fill="#101014"
            rotation={(seed % 9) - 4}
            origin="0, 0"
          />
          <Rect
            x={7}
            y={-12}
            width={7}
            height={24}
            rx={3.5}
            fill="#101014"
            rotation={(seed % 9) - 4}
            origin="0, 0"
          />
        </Svg>
      </View>
    );
  }
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
        borderWidth: isWorking ? 2 : 0,
        borderColor: "#FFFFFF",
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
        {[0, 1].map((eye) => (
          <View
            key={eye}
            style={{
              width: eyeW,
              height: eyeH,
              borderRadius: Math.max(2, Math.round(eyeW * 0.6)),
              backgroundColor: "#fff",
            }}
          />
        ))}
      </View>
    </View>
  );
});
