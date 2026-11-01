import { BotAvatarValueSchema, parseBotAvatarValue } from "@rakazo/contracts";
import { avatarIdentitySeed, organicAvatarPath } from "./avatar-shape.js";
import { resolvePersonaColorDef } from "./bot-avatar-colors.js";
import {
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
  SHIPPED_BOT_AVATAR_SHAPES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
} from "./bot-avatar-shapes.js";
import { LOGO_BODY_PATH } from "./logo-avatar-art.js";
import { logoAvatarTraits } from "./logo-avatar-traits.js";

/** A static notification portrait, with the same identity, saved photo and silhouette as chat. */
export function notificationAvatarSource(bot: {
  id: string;
  color: string;
  avatarSet?: string | null;
}): string {
  const parsed = BotAvatarValueSchema.safeParse(bot.color).success
    ? parseBotAvatarValue(bot.color)
    : null;
  if (parsed?.kind === "image") return parsed.imageUrl;
  const colorDef = resolvePersonaColorDef(
    bot.id,
    parsed && "color" in parsed ? parsed.color : bot.color,
  );
  const color = colorDef.hex;
  const botEyeColor = colorDef.eyeColor;
  let viewBox = "-60 -60 120 120";
  let body = `<path d="${organicAvatarPath(avatarIdentitySeed(bot.id))}" fill="${color}"/><g fill="${botEyeColor}"><rect x="-14" y="-10" width="8" height="22" rx="4"/><rect x="6" y="-10" width="8" height="22" rx="4"/></g>`;
  if (parsed?.kind === "shape") {
    viewBox = SHIPPED_BOT_AVATAR_VIEWBOX;
    body = `<path d="${SHIPPED_BOT_AVATAR_SHAPES[SHIPPED_BOT_AVATAR_SHAPE_KEYS[parsed.shapeIndex]!]}" fill="${color}"/><g fill="${botEyeColor}"><rect x="83" y="89" width="15" height="43" rx="7"/><rect x="130" y="89" width="15" height="43" rx="7"/></g>`;
  } else if (bot.avatarSet === "rakazo") {
    viewBox = "0 0 100 100";
    body = `<path d="${LOGO_BODY_PATH}" fill="${logoAvatarTraits(bot.id, color).color}"/><g fill="${botEyeColor}"><rect x="35" y="35" width="9" height="23" rx="4"/><rect x="56" y="35" width="9" height="23" rx="4"/></g>`;
  }
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${viewBox}">${body}</svg>`)}`;
}
