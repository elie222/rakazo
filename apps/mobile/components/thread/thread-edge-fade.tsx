import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { mobileTokens } from "../../lib/appearance";

/** Fades messages scrolling under the header or the composer into the thread background. */
export function ThreadEdgeFade({ edge, height }: { edge: "top" | "bottom"; height: number }) {
  const color = mobileTokens().background;
  const id = `thread-fade-${edge}`;
  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", left: 0, right: 0, height, [edge]: 0 }}
    >
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient
            id={id}
            x1="0"
            y1={edge === "top" ? "1" : "0"}
            x2="0"
            y2={edge === "top" ? "0" : "1"}
          >
            <Stop offset="0" stopColor={color} stopOpacity={0} />
            <Stop offset="0.45" stopColor={color} stopOpacity={0.8} />
            <Stop offset="0.75" stopColor={color} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={height} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}
