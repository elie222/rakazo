import { storeBotWebhookKey } from "@rakazo/adapters";
import { botInboundUrl } from "@rakazo/contracts";
import { recordSecurityEvent } from "@rakazo/db";
import type { AdminCommand, AdminDbContext, AdminResult } from "./admin-command.js";
import { AdminCommandError } from "./admin-command.js";

const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const botWebhookKeyCommand: AdminCommand = {
  path: ["bot", "webhook-key"],
  usage: "<bot-id> [--rotate]",
  flags: ["rotate"],
  parse: (args, flags) => {
    const [botId, ...extra] = args;
    if (!botId || extra.length || !BOT_ID.test(botId)) return null;
    return (context) => botWebhookKey(context, botId, flags.rotate === true);
  },
};

/** Issues a bot's webhook key when it has none, or replaces it on `rotate`; never prints one it has. */
export async function botWebhookKey(
  context: AdminDbContext,
  botId: string,
  rotate: boolean,
): Promise<AdminResult> {
  const bot = await context.prisma.bot.findUnique({
    where: { id: botId },
    select: { id: true, spaceId: true, userId: true, archivedAt: true },
  });
  if (!bot) throw new AdminCommandError("No bot has that id");
  if (bot.archivedAt) throw new AdminCommandError("That bot is archived; restore it first");
  const url = botInboundUrl(context.inboundOrigin ?? context.apiUrl, bot.id, "webhook");
  const key = await storeBotWebhookKey(
    { prisma: context.prisma, secretStore: context.secrets },
    bot,
    {
      operationId: "admin.bot.webhookKey",
      traceId: "admin.bot.webhookKey",
      spaceId: bot.spaceId,
      userId: bot.userId,
      signal: context.signal,
    },
    { replace: rotate },
  );
  if (!key) {
    if (rotate) throw new AdminCommandError("No bot has that id");
    return {
      text: `${url}\nThis bot already has a webhook key. --rotate replaces it.`,
      json: { botId: bot.id, url, created: false },
    };
  }
  await recordSecurityEvent({
    type: "credential.changed",
    userId: bot.userId,
    spaceId: bot.spaceId,
    metadata: { procedure: "admin.bot.webhookKey", kind: "webhook", botId: bot.id, by: "operator" },
  });
  return { text: `${url}\n${key}`, json: { botId: bot.id, url, key, created: true } };
}
