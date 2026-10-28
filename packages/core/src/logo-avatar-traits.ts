import {
  contrastRatio,
  resolvePersonaColorDef,
  shippedHash,
  shippedRandom,
} from "./bot-avatar-colors.js";

/** Every supported track completes whole cycles in this exact export interval. */
export const LOGO_AVATAR_LOOP_MS = 24_000;
const SLOW_PERIODS = [4000, 4800, 6000] as const;

/** A saved bot id supplies the colour seed; this stream never advances its motion clocks. */
export function seededLogoAvatarColor(identity: string): string {
  const random = shippedRandom(shippedHash(`logo-avatar/color/v1/${identity}`));
  const hue = random() * 6;
  const saturation = 0.65 + random() * 0.2;
  const second = 1 - Math.abs((hue % 2) - 1);
  const channels = [
    [1, second, 0],
    [second, 1, 0],
    [0, 1, second],
    [0, second, 1],
    [second, 0, 1],
    [1, 0, second],
  ][Math.floor(hue)]!;
  let lightness = 0.54 + random() * 0.1;
  const hex = () => {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const offset = lightness - chroma / 2;
    return `#${channels
      .map((value) =>
        Math.round((value * chroma + offset) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`.toUpperCase();
  };
  let color = hex();
  // Leave headroom for the shaded flank while keeping the existing dark eye ink clear.
  while (contrastRatio(color, "#141414") < 7 && lightness < 0.85) {
    lightness += 0.01;
    color = hex();
  }
  return color;
}

/** Evaluate once per identity, never on an animation frame or from React's useId. */
export function logoAvatarTraits(identity: string, color?: string) {
  const random = shippedRandom(shippedHash(`logo-avatar/v2/${identity}`));
  const blinkVariant = random() < 0.5 ? "three" : "four";
  const blinkMs = LOGO_AVATAR_LOOP_MS;
  const blinkDelayMs = -Math.round(random() * blinkMs * 1000) / 1000;
  const tempo = Math.floor(random() * 3);
  const phase = random();
  const side = random() > 0.5 ? 1 : -1;
  const energy = 0.92 + random() * 0.16;
  const colorDef = resolvePersonaColorDef(identity, color || seededLogoAvatarColor(identity));
  return {
    color: colorDef.hex,
    originalOrange: colorDef.id === "orange",
    blinkMs,
    blinkVariant,
    blinkDelayMs,
    phase,
    side,
    energy,
    periods: {
      idle: LOGO_AVATAR_LOOP_MS,
      working: SLOW_PERIODS[tempo]!,
      reading: SLOW_PERIODS[tempo]!,
      writing: [1200, 1500, 2000][tempo]!,
      thinking: 6000,
      computer: 6000,
      waiting: SLOW_PERIODS[tempo]!,
      error: SLOW_PERIODS[tempo]!,
    },
  } as const;
}
