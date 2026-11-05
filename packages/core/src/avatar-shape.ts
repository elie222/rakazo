export function avatarIdentitySeed(identity: string): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index++) {
    hash = (hash << 5) - hash + identity.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Two eyes of one size, placed by their centres in the avatar's own view box. */
export interface AvatarEyes {
  readonly width: number;
  readonly height: number;
  readonly leftCx: number;
  readonly rightCx: number;
  readonly cy: number;
}

/** The pair as fully rounded bars, the face every organic and shipped-shape avatar wears. */
export function avatarEyeRects(eyes: AvatarEyes) {
  return [eyes.leftCx, eyes.rightCx].map((cx) => ({
    x: cx - eyes.width / 2,
    y: eyes.cy - eyes.height / 2,
    width: eyes.width,
    height: eyes.height,
    rx: eyes.width / 2,
  }));
}

/** Organic bodies come in this many families; the seed picks one. */
export const ORGANIC_AVATAR_FAMILY_COUNT = 10;

/** The scallop. Bots that already have it keep it; new bots are not handed it. */
export const ORGANIC_AVATAR_HEART_FAMILY = 6;

/** The organic body family every client draws for this identity (a bot's id). */
export function organicAvatarFamily(identity: string): number {
  return avatarIdentitySeed(identity) % ORGANIC_AVATAR_FAMILY_COUNT;
}

/** Families 2 and 8 (the squircle and the pill) read alike at row size, so they count as one look. */
export function organicAvatarLook(family: number): number {
  return family === 8 ? 2 : family;
}

/** The distinct organic bodies a new bot can get: every look except the heart. */
export const ORGANIC_AVATAR_LOOKS: readonly number[] = [
  ...new Set(
    Array.from({ length: ORGANIC_AVATAR_FAMILY_COUNT }, (_, family) => family)
      .filter((family) => family !== ORGANIC_AVATAR_HEART_FAMILY)
      .map(organicAvatarLook),
  ),
];

/** A stable identity whose organic body is the given family, for previews before a bot has an id. */
export function organicAvatarSampleIdentity(family: number): string {
  for (let index = 0; ; index++) {
    const identity = `look-${family}-${index}`;
    if (organicAvatarFamily(identity) === family) return identity;
  }
}

/** Organic avatars are drawn in a 100-unit box, the face looking straight out. */
export const ORGANIC_AVATAR_VIEWBOX = "0 0 100 100";

const circle = (cx: number, cy: number, r: number) => ellipse(cx, cy, r, r);
const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
const roundedRect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;

/** A polygon (clockwise on screen) grown by `r` on every side, its corners rounded to `r`. */
function softPolygon(points: readonly (readonly [number, number])[], r: number): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  const edges = points.map((point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    const length = Math.hypot(next[0] - point[0], next[1] - point[1]);
    const nx = ((next[1] - point[1]) / length) * r;
    const ny = (-(next[0] - point[0]) / length) * r;
    return [
      [round(point[0] + nx), round(point[1] + ny)],
      [round(next[0] + nx), round(next[1] + ny)],
    ] as const;
  });
  const start = edges[0]?.[0] ?? [0, 0];
  return `M${start[0]} ${start[1]}${edges
    .map(([, end], index) => {
      const after = edges[(index + 1) % edges.length]?.[0] ?? start;
      return `L${end[0]} ${end[1]}A${r} ${r} 0 0 1 ${after[0]} ${after[1]}`;
    })
    .join("")}Z`;
}

/** One body per family; the face sits this many units lower on bodies whose mass sits low. */
const ORGANIC_BODIES: readonly { path: string; faceDrop: number }[] = [
  { path: circle(50, 50, 46), faceDrop: 0 },
  {
    path: [
      circle(46, 55, 30),
      circle(35, 31, 17),
      circle(64, 30, 20),
      circle(78, 55, 18),
      circle(26, 69, 17),
      circle(56, 76, 17),
    ].join(""),
    faceDrop: 0,
  },
  { path: roundedRect(10, 10, 80, 80, 30), faceDrop: 0 },
  {
    path: [ellipse(50, 50, 46, 23), ellipse(50, 50, 23, 46), circle(50, 50, 29)].join(""),
    faceDrop: 0,
  },
  {
    path: softPolygon(
      [
        [50, 8],
        [86, 29],
        [86, 71],
        [50, 92],
        [14, 71],
        [14, 29],
      ],
      6,
    ),
    faceDrop: 0,
  },
  {
    path: "M10 50A40 40 0 0 1 50 10A40 40 0 0 1 90 50L90 76Q90 90 76 90L50 90A40 40 0 0 1 10 50Z",
    faceDrop: 2,
  },
  {
    path: [
      ...Array.from({ length: 10 }, (_, index) => {
        const angle = (index * Math.PI) / 5;
        return circle(
          Math.round((50 + 33 * Math.cos(angle)) * 10) / 10,
          Math.round((50 + 33 * Math.sin(angle)) * 10) / 10,
          15,
        );
      }),
      circle(50, 50, 36),
    ].join(""),
    faceDrop: 0,
  },
  { path: "M10 50A40 40 0 0 1 50 10L84 10Q90 10 90 16L90 50A40 40 0 0 1 10 50Z", faceDrop: 4 },
  { path: roundedRect(6, 24, 88, 52, 26), faceDrop: 0 },
  {
    path: softPolygon(
      [
        [50, 16],
        [86, 80],
        [14, 80],
      ],
      7,
    ),
    faceDrop: 8,
  },
];

const organicBody = (seed: number) =>
  ORGANIC_BODIES[seed % ORGANIC_AVATAR_FAMILY_COUNT] ??
  (ORGANIC_BODIES[0] as (typeof ORGANIC_BODIES)[0]);

/** The body every client draws for this seed (`avatarIdentitySeed` of a bot's id). */
export function organicAvatarPath(seed: number): string {
  return organicBody(seed).path;
}

/** Two upright bar eyes, centred, lowered a little on bottom-heavy bodies. */
export function organicAvatarEyes(seed: number): AvatarEyes {
  return {
    width: 11,
    height: 22,
    leftCx: 36.5,
    rightCx: 63.5,
    cy: 49 + organicBody(seed).faceDrop,
  };
}

/** The blush under each eye and the small smile a face shows when it is happy (a hop, or work). */
export function avatarCheer(eyes: AvatarEyes) {
  const unit = eyes.height / 22;
  const centre = (eyes.leftCx + eyes.rightCx) / 2;
  const top = eyes.cy + 17 * unit;
  return {
    cheeks: [centre - 23 * unit, centre + 23 * unit].map((cx) => ({
      cx,
      cy: eyes.cy + 15 * unit,
      rx: 6.5 * unit,
      ry: 4.2 * unit,
    })),
    smile: `M${centre - 7 * unit} ${top}Q${centre} ${eyes.cy + 24 * unit} ${centre + 7 * unit} ${top}`,
  };
}
