import { notificationAvatarSource } from "@rakazo/core";

/** Small enough to travel inside a push without exposing an authenticated avatar URL. */
export async function notificationIdentity(bot: {
  id: string;
  name: string;
  color: string;
  avatarSet?: string | null;
}): Promise<{ botId: string; name: string; avatar?: string }> {
  const source = notificationAvatarSource(bot);
  const identity = { botId: bot.id, name: bot.name.trim().slice(0, 100) || "Bot" };
  try {
    const comma = source.indexOf(",");
    const bytes = source.startsWith("data:image/svg+xml,")
      ? Buffer.from(decodeURIComponent(source.slice(comma + 1)))
      : Buffer.from(source.slice(comma + 1), "base64");
    const { default: sharp } = await import("sharp");
    const avatar = await sharp(bytes, { limitInputPixels: 1_048_576 })
      .rotate()
      .resize(40, 40, { fit: "cover" })
      .flatten({ background: "white" })
      .jpeg({ quality: 30 })
      .toBuffer();
    return {
      ...identity,
      ...(avatar.length <= 1050 ? { avatar: avatar.toString("base64") } : {}),
    };
  } catch {
    return identity;
  }
}
