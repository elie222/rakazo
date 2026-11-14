import type { ComponentProps } from "react";
import Animated from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { mobileTokens } from "../../lib/appearance";

/**
 * Fades messages scrolling under the header or the composer into the thread background.
 * The caller sets the height, which may be animated.
 */
export function ThreadEdgeFade({
  edge,
  style,
}: {
  edge: "top" | "bottom";
  style: ComponentProps<typeof Animated.View>["style"];
}) {
  const color = mobileTokens().background;
  const id = `thread-fade-${edge}`;
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: "absolute", left: 0, right: 0, [edge]: 0 }, style]}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient
            id={id}
            x1="0"
            y1={edge === "top" ? "1" : "0"}
            x2="0"
            y2={edge === "top" ? "0" : "1"}
          >
            <Stop offset="0" stopColor={color} stopOpacity={0} />
            {/* Never solid: messages stay faintly visible at the very edge. */}
            <Stop offset="0.6" stopColor={color} stopOpacity={0.7} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}
