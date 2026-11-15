import {
  avatarEyeRects,
  avatarIdentitySeed,
  botEyeInk,
  ORGANIC_AVATAR_EYES,
  ORGANIC_AVATAR_VIEWBOX,
  organicAvatarEyeTilt,
  organicAvatarPath,
  SHIPPED_BOT_AVATAR_EYES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
} from "@rakazo/core";
import type { ReactNode } from "react";
import { memo, useId } from "react";
import type { ColorValue } from "react-native";
import { View } from "react-native";
import Svg, { Circle, ClipPath, Defs, G, Image, Mask, Path, Rect } from "react-native-svg";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import type { GroupSeat } from "../lib/group-seats";
import { GROUP_SEAT_SIZE, groupSeatGap, groupSeatStep, groupSeatsWidth } from "../lib/group-seats";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";

type SeatMember = { botId?: string; name?: string; color: string };

type Paint = { fill: ColorValue; stroke?: string; strokeWidth?: number };

/** A seat's drawing in its own units; its outline cuts the seat under it. */
type SeatArt = {
  box: [number, number, number];
  outline: (paint: Paint) => ReactNode;
  face: ReactNode;
};

/**
 * The group title's stack of member faces: the first sits on top and each one after tucks
 * under the one before it, cut away around it so the header shows through. Faces stay still.
 */
export const GroupSeats = memo(function GroupSeats({
  seats,
  size = GROUP_SEAT_SIZE,
}: {
  seats: readonly GroupSeat<SeatMember>[];
  size?: number;
}) {
  const id = useId().replace(/:/g, "");
  // Redraws the faint "#" when the appearance changes.
  useResolvedAppearance();
  const page = useMobileTokens();
  const step = groupSeatStep(size);
  const gap = groupSeatGap(size);
  const width = groupSeatsWidth(seats.length, size);
  const arts = seats.map((seat, index) =>
    seat.kind === "member"
      ? seatArt(seat.member, size, `${id}-${index}`, page)
      : groupMarkArt(native.systemTertiaryLabel),
  );
  const placed = (index: number, art: SeatArt) => {
    const [x, y, units] = art.box;
    return `translate(${index * step} 0) scale(${size / units}) translate(${-x} ${-y})`;
  };
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width, height: size }}
    >
      <Svg width={width} height={size}>
        <Defs>
          {arts.slice(0, -1).map((above, index) => (
            <Mask
              key={index}
              id={`${id}-carve-${index + 1}`}
              maskUnits="userSpaceOnUse"
              x={0}
              y={-size}
              width={width}
              height={size * 3}
            >
              <Rect x={0} y={-size} width={width} height={size * 3} fill="white" />
              <G transform={placed(index, above)} strokeLinejoin="round">
                {above.outline({
                  fill: "black",
                  stroke: "black",
                  strokeWidth: (2 * gap * above.box[2]) / size,
                })}
              </G>
            </Mask>
          ))}
        </Defs>
        {arts.map((art, index) => (
          <G key={index} mask={index > 0 ? `url(#${id}-carve-${index})` : undefined}>
            <G transform={placed(index, art)}>{art.face}</G>
          </G>
        ))}
      </Svg>
    </View>
  );
});

/** The group's "#" mark: ink, no disc, about two thirds of the seat across in a 24-unit box. */
function groupMarkArt(color: ColorValue): SeatArt {
  const hash = (paint: Paint) => (
    <Path
      d="M9.5 4L8 20M16 4L14.5 20M4.5 9H20M4 15H19.5"
      fill="none"
      stroke={paint.stroke ?? paint.fill}
      strokeWidth={2 + (paint.strokeWidth ?? 0)}
      strokeLinecap="round"
    />
  );
  return { box: [0, 0, 24], outline: hash, face: hash({ fill: color }) };
}

/** A still face in the member's shape: the same drawing as their avatar at rest. */
function seatArt(
  member: SeatMember,
  size: number,
  key: string,
  page: { background: string; foreground: string },
): SeatArt {
  const parsed = mobileBotAvatarPresentation(member.color);
  const r = size / 2;
  if (parsed.kind === "image" && parsed.imageUrl) {
    // Drawn in points, so the photo keeps its full resolution.
    return {
      box: [0, 0, size],
      outline: (paint) => <Circle cx={r} cy={r} r={r} {...paint} />,
      face: (
        <>
          <ClipPath id={`${key}-photo`}>
            <Circle cx={r} cy={r} r={r} />
          </ClipPath>
          {/* A plain circle holds the photo's place while it loads, as on the avatar. */}
          <Circle cx={r} cy={r} r={r} fill={native.fill} />
          <Image
            href={{ uri: parsed.imageUrl }}
            width={size}
            height={size}
            preserveAspectRatio="xMidYMid slice"
            clipPath={`url(#${key}-photo)`}
          />
        </>
      ),
    };
  }
  if (parsed.kind === "shape") {
    const [x, y, units] = SHIPPED_BOT_AVATAR_VIEWBOX.split(" ").map(Number) as [
      number,
      number,
      number,
    ];
    return {
      box: [x, y, units],
      outline: (paint) => <Path d={parsed.shapePath} {...paint} />,
      face: (
        <>
          <Path d={parsed.shapePath} fill={parsed.color} />
          <G fill={botEyeInk(parsed.color, page)}>
            {avatarEyeRects(SHIPPED_BOT_AVATAR_EYES).map((rect) => (
              <Rect key={rect.x} {...rect} />
            ))}
          </G>
        </>
      ),
    };
  }
  const color = parsed.kind === "color" ? parsed.color : member.color;
  const seed = avatarIdentitySeed(member.botId ?? member.name ?? color);
  const outline = organicAvatarPath(seed);
  const [x, y, units] = ORGANIC_AVATAR_VIEWBOX.split(" ").map(Number) as [number, number, number];
  return {
    box: [x, y, units],
    outline: (paint) => <Path d={outline} {...paint} />,
    face: (
      <>
        <Path d={outline} fill={color} />
        <G transform={`rotate(${organicAvatarEyeTilt(seed)})`} fill={botEyeInk(color, page)}>
          {avatarEyeRects(ORGANIC_AVATAR_EYES).map((rect) => (
            <Rect key={rect.x} {...rect} />
          ))}
        </G>
      </>
    ),
  };
}
