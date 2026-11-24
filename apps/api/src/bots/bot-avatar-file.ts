import { createHash } from "node:crypto";
import { BOT_AVATAR_FILE_PATH, botAvatarFileUrl, isBotAvatarValue } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";
import type { Hono } from "hono";
import { matchesIfNoneMatch } from "../http/conditional-request.js";

function avatarVersion(color: string): string {
  return createHash("sha256").update(color).digest("hex").slice(0, 32);
}

function isAvatarImage(color: string): boolean {
  return color.startsWith("data:image/") && isBotAvatarValue(color);
}

/** Keep the persisted photo available to exports, notifications and older clients. */
export function rosterAvatarFile(spaceId: string, botId: string, color: string): string {
  if (!isAvatarImage(color)) return color;
  return botAvatarFileUrl(spaceId, botId, avatarVersion(color)) ?? color;
}

export function mountBotAvatarFiles(
  app: Hono,
  prisma: PrismaClient,
  userForRequest: (request: Request) => Promise<string | undefined>,
) {
  app.get(`${BOT_AVATAR_FILE_PATH}/:spaceId/:botId/:version`, async (c) => {
    const { spaceId, botId, version } = c.req.param();
    const userId = await userForRequest(c.req.raw);
    if (!userId) return c.body(null, 404, { "cache-control": "no-store" });
    const bot = await runAsTenant({ spaceId, userId }, () =>
      prisma.bot.findFirst({
        where: { id: botId, spaceId, space: { memberships: { some: { userId } } } },
        select: { color: true },
      }),
    );
    if (!bot || !isAvatarImage(bot.color) || version !== avatarVersion(bot.color)) {
      return c.body(null, 404, { "cache-control": "no-store" });
    }

    const etag = `"${version}"`;
    const headers = {
      "cache-control": "private, no-cache",
      "cross-origin-resource-policy": "same-origin",
      vary: "Cookie, Authorization",
      "x-content-type-options": "nosniff",
      etag,
    };
    if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);

    const separator = bot.color.indexOf(",");
    const mime = bot.color.slice("data:".length, bot.color.indexOf(";"));
    const bytes = Buffer.from(bot.color.slice(separator + 1), "base64");
    return c.body(new Uint8Array(bytes), 200, { ...headers, "content-type": mime });
  });
}
