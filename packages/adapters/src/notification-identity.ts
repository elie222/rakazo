import { createHash } from "node:crypto";
import { notificationAvatarSource } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

/** Installed apps drop an avatar over 1400 base64 characters, and Android one over 96px. */
const MAX_AVATAR_BYTES = 1050;
/** Largest that fits first; iOS draws the sender at about 40pt, so 40px alone looked blurry. */
const AVATAR_SIZES = [96, 64, 40];
const MAX_CACHED_AVATARS = 1000;
/**
 * Thumbnails by bot id, keyed on the avatar inputs so an edited avatar renders again. The render
 * is stored before it settles, so concurrent sends share it and a failed render is not retried.
 */
const avatars = new Map<string, { key: string; avatar: Promise<string | undefined> }>();

async function renderAvatar(bot: { id: string; color: string; avatarSet?: string | null }) {
  const source = notificationAvatarSource(bot);
  const comma = source.indexOf(",");
  const bytes = source.startsWith("data:image/svg+xml,")
    ? Buffer.from(decodeURIComponent(source.slice(comma + 1)))
    : Buffer.from(source.slice(comma + 1), "base64");
  const { default: sharp } = await import("sharp");
  const image = sharp(bytes, { limitInputPixels: 16_777_216 }).rotate();
  for (const size of AVATAR_SIZES) {
    const avatar = await image
      .clone()
      .resize(size, size, { fit: "cover" })
      .flatten({ background: "white" })
      .jpeg({ quality: 30, mozjpeg: true })
      .toBuffer();
    if (avatar.length <= MAX_AVATAR_BYTES) return avatar.toString("base64");
  }
  return undefined;
}

/** Small enough to travel inside a push without exposing an authenticated avatar URL. */
export async function notificationIdentity(bot: {
  id: string;
  name: string;
  color: string;
  avatarSet?: string | null;
}) {
  const key = createHash("sha256")
    .update(`${bot.avatarSet ?? ""}\n${bot.color}`)
    .digest("base64url");
  let cached = avatars.get(bot.id);
  if (cached?.key !== key) {
    cached = {
      key,
      avatar: renderAvatar(bot).catch((error: unknown) => {
        getLogger().error("notification avatar", error);
        return undefined;
      }),
    };
    avatars.delete(bot.id);
    if (avatars.size >= MAX_CACHED_AVATARS) avatars.delete(avatars.keys().next().value!);
    avatars.set(bot.id, cached);
  }
  const avatar = await cached.avatar;
  return {
    botId: bot.id,
    name: bot.name.trim().slice(0, 100) || "Bot",
    ...(avatar ? { avatar } : {}),
  };
}
