import { notificationAvatarSource } from "@rakazo/core";

/** Small enough to travel inside a push without exposing an authenticated avatar URL. */
export async function notificationIdentity(bot: {
  id: string;
  name: string;
  color: string;
  avatarSet?: string | null;
}) {
  const source = notificationAvatarSource(bot);
  const comma = source.indexOf(",");
  const bytes = source.startsWith("data:image/svg+xml,")
    ? Buffer.from(decodeURIComponent(source.slice(comma + 1)))
    : Buffer.from(source.slice(comma + 1), "base64");
  const { default: sharp } = await import("sharp");
  const avatar = await sharp(bytes, { limitInputPixels: 16_777_216 })
    .rotate()
    .resize(40, 40, { fit: "cover" })
    .flatten({ background: "white" })
    .jpeg({ quality: 30 })
    .toBuffer();
  return {
    botId: bot.id,
    name: bot.name.trim().slice(0, 100) || "Bot",
    ...(avatar.length <= 1050 ? { avatar: avatar.toString("base64") } : {}),
  };
}
