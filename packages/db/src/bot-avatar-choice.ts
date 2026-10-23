import { randomInt } from "node:crypto";
import { BOT_COLORS, parseBotAvatarValue } from "@rakazo/contracts";
import {
  ORGANIC_AVATAR_FAMILY_COUNT,
  ORGANIC_AVATAR_HEART_FAMILY,
  organicAvatarFamily,
  organicAvatarLook,
} from "@rakazo/core";

/** A uniform number in [0, 1). */
export type Random = () => number;

const RANDOM_RANGE = 2 ** 32;
const cryptoRandom: Random = () => randomInt(RANDOM_RANGE) / RANDOM_RANGE;

/** Tries before settling for a non-heart id; each try matches the wanted family about 1 in 10. */
export const BOT_ID_ATTEMPTS = 200;

/** One of the options the existing values use least, at random among ties, preferring any not in `avoid`. */
export function pickLeastUsed<T>(
  options: readonly T[],
  used: readonly T[],
  random: Random,
  avoid: readonly T[] = [],
): T {
  const counts = options.map((option) => used.filter((value) => value === option).length);
  const fewest = Math.min(...counts);
  const least = options.filter((_, index) => counts[index] === fewest);
  const preferred = least.filter((option) => !avoid.includes(option));
  const candidates = preferred.length > 0 ? preferred : least;
  return candidates[Math.floor(random() * candidates.length)] ?? options[0]!;
}

/** Cuid-shaped: "c", eight base-36 time digits, then sixteen random base-36 digits. */
function cuidShapedId(random: Random, now: number): string {
  let suffix = "";
  for (let index = 0; index < 16; index++) suffix += Math.floor(random() * 36).toString(36);
  return `c${now.toString(36).padStart(8, "0").slice(-8)}${suffix}`;
}

/**
 * Picks the id and colour of a new bot so it looks unlike the user's other bots.
 *
 * Every client draws a bot's organic body from a hash of its id (`organicAvatarFamily`), and
 * no shape is stored. Choosing the id is therefore how the choice reaches every device the
 * same way, app builds already installed included, without a new column or avatar value.
 * Existing bots keep their ids, so their look never changes.
 *
 * Shapes are balanced by look, where two near-identical families count as one, and a tie
 * between colours goes to one no bot with the same look wears. Bots with a picture or an
 * Avatar Studio shape do not draw an organic body and are not counted for the look. A colour
 * passed by the caller is kept.
 */
export function chooseBotAvatar(
  existing: readonly { id: string; color: string }[],
  color: string | undefined,
  { random = cryptoRandom, now = Date.now() }: { random?: Random; now?: number } = {},
): { id: string; color: string } {
  const avatars = existing.map((bot) => {
    const avatar = parseBotAvatarValue(bot.color);
    return {
      look:
        avatar.kind === "color" || avatar.kind === "other"
          ? organicAvatarLook(organicAvatarFamily(bot.id))
          : null,
      color: avatar.kind === "color" || avatar.kind === "shape" ? avatar.color.toUpperCase() : null,
    };
  });
  const looks = [
    ...new Set(
      Array.from({ length: ORGANIC_AVATAR_FAMILY_COUNT }, (_, family) => family)
        .filter((family) => family !== ORGANIC_AVATAR_HEART_FAMILY)
        .map(organicAvatarLook),
    ),
  ];
  const look = pickLeastUsed(
    looks,
    avatars.flatMap((avatar) => (avatar.look === null ? [] : [avatar.look])),
    random,
  );
  const lookOf = (botId: string) => organicAvatarLook(organicAvatarFamily(botId));
  const isHeart = (botId: string) => organicAvatarFamily(botId) === ORGANIC_AVATAR_HEART_FAMILY;
  let id = cuidShapedId(random, now);
  let lastNonHeart = isHeart(id) ? undefined : id;
  for (let attempt = 1; attempt < BOT_ID_ATTEMPTS && lookOf(id) !== look; attempt++) {
    id = cuidShapedId(random, now);
    if (!isHeart(id)) lastNonHeart = id;
  }
  // The cap may relax balancing, but must never relax the heart exclusion.
  if (isHeart(id) && lastNonHeart) id = lastNonHeart;
  while (isHeart(id)) id = cuidShapedId(random, now);
  const colors = (bots: typeof avatars) =>
    bots.flatMap((avatar) => (avatar.color === null ? [] : [avatar.color]));
  return {
    id,
    color:
      color ??
      pickLeastUsed(
        BOT_COLORS,
        colors(avatars),
        random,
        colors(avatars.filter((avatar) => avatar.look === lookOf(id))),
      ),
  };
}
