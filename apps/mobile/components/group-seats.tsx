import {
  avatarIdentitySeed,
  organicAvatarPath,
  SHIPPED_BOT_AVATAR_CENTER,
  SHIPPED_BOT_AVATAR_VIEWBOX,
} from "@rakazo/core";
import { botEyeColor } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { memo, useId } from "react";
import type { ColorValue } from "react-native";
import { View } from "react-native";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  Image,
  Mask,
  Path,
  Rect,
  Text as SvgText,
} from "react-native-svg";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import type { GroupSeat } from "../lib/group-seats";
import {
  GROUP_SEAT_SIZE,
  groupSeatGap,
  groupSeatStep,
  groupSeats,
  groupSeatsWidth,
} from "../lib/group-seats";
import { native, useResolvedAppearance } from "../lib/native";

type SeatMember = { botId?: string; name?: string; color: string };

type Paint = { fill: ColorValue; stroke?: string; strokeWidth?: number };

/** A seat's drawing in its own units; its outline cuts the seat under it. */
type SeatArt = {
  box: [number, number, number];
  outline: (paint: Paint) => ReactNode;
  face: ReactNode;
};

/**
 * The group title's row of member faces: each seat overlaps the one before it, which is cut
 * away around it so the header shows through. Faces stay still here.
 */
export const GroupSeats = memo(function GroupSeats({
  members,
  size = GROUP_SEAT_SIZE,
}: {
  members: readonly SeatMember[];
  size?: number;
}) {
  const id = useId().replace(/:/g, "");
  // Redraws the faint "+N" when the appearance changes.
  useResolvedAppearance();
  const seats = groupSeats(members);
  const step = groupSeatStep(size);
  const gap = groupSeatGap(size);
  const width = groupSeatsWidth(seats.length, size);
  const arts = seats.map((seat, index) =>
    seat.kind === "member"
      ? seatArt(seat.member, size, `${id}-${index}`)
      : markArt(seat, size, native.systemTertiaryLabel),
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
          {arts.slice(1).map((next, before) => (
            <Mask
              key={before}
              id={`${id}-carve-${before}`}
              maskUnits="userSpaceOnUse"
              x={0}
              y={-size}
              width={width}
              height={size * 3}
            >
              <Rect x={0} y={-size} width={width} height={size * 3} fill="white" />
              <G transform={placed(before + 1, next)} strokeLinejoin="round">
                {next.outline({
                  fill: "black",
                  stroke: "black",
                  strokeWidth: (2 * gap * next.box[2]) / size,
                })}
              </G>
            </Mask>
          ))}
        </Defs>
        {arts.map((art, index) => (
          <G key={index} mask={arts[index + 1] ? `url(#${id}-carve-${index})` : undefined}>
            <G transform={placed(index, art)}>{art.face}</G>
          </G>
        ))}
      </Svg>
    </View>
  );
});

/** The "+N" for members past the row, or the group's "#" mark: ink, no disc. */
function markArt(
  seat: Exclude<GroupSeat<SeatMember>, { kind: "member" }>,
  size: number,
  color: ColorValue,
): SeatArt {
  if (seat.kind === "group") {
    // A hash about two thirds of the seat across, in a 24-unit box.
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
  const fontSize = Math.round(size * 0.74);
  const label = (paint: Paint) => (
    <SvgText
      x={size / 2}
      // Centre the figures' cap height in the seat.
      y={size / 2 + fontSize * 0.36}
      textAnchor="middle"
      fontSize={fontSize}
      fontWeight="600"
      {...paint}
    >
      {`+${seat.count}`}
    </SvgText>
  );
  return { box: [0, 0, size], outline: label, face: label({ fill: color }) };
}

/** A still face in the member's shape: the same drawing as their avatar at rest. */
function seatArt(member: SeatMember, size: number, key: string): SeatArt {
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
    const center = SHIPPED_BOT_AVATAR_CENTER;
    return {
      box: [x, y, units],
      outline: (paint) => <Path d={parsed.shapePath} {...paint} />,
      face: (
        <>
          <Path d={parsed.shapePath} fill={parsed.color} />
          <G fill={parsed.eyeColor}>
            <Ellipse cx={center - 29} cy={center - 8} rx={10} ry={7} />
            <Ellipse cx={center + 29} cy={center - 8} rx={10} ry={7} />
          </G>
        </>
      ),
    };
  }
  const color = parsed.kind === "color" ? parsed.color : member.color;
  const seed = avatarIdentitySeed(member.botId ?? member.name ?? color);
  const outline = organicAvatarPath(seed);
  return {
    box: [-60, -60, 120],
    outline: (paint) => <Path d={outline} {...paint} />,
    face: (
      <>
        <Path d={outline} fill={color} />
        <G transform={`rotate(${(seed % 9) - 4})`} fill={botEyeColor}>
          <Rect x={-14} y={-12} width={7} height={24} rx={3.5} />
          <Rect x={7} y={-12} width={7} height={24} rx={3.5} />
        </G>
      </>
    ),
  };
}
