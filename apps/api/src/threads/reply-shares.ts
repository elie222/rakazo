import { randomBytes } from "node:crypto";
import type { Actor, ReplyShareSummary, SharedReply } from "@rakazo/contracts";
import { isReplyShareToken, replyShareUrl, SHARED_REPLY_PATH_PREFIX } from "@rakazo/contracts";
import { ClientError, canShareReply, sharedReplyText, truncatePlainText } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  IsolationError,
  isForeignKeyViolation,
  runAsSystem,
  storedMessageBlocks,
} from "@rakazo/db";
import { redactSensitiveText } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { hashPageShareToken } from "../content/pages.js";
import { mountShareLinkRead } from "../content/shared-pages.js";
import type { ThreadTarget } from "./thread-target.js";

const PREVIEW_CHARS = 80;

/** Exactly what a reply's link shows of it, or null when the message is not a reply that can. */
function publicReplyText(message: { id: string; role: string; blocks: unknown }): string | null {
  const reply = { id: message.id, role: message.role, blocks: storedMessageBlocks(message) };
  return canShareReply(reply) ? sharedReplyText(reply, redactSensitiveText) : null;
}

/** A new link to one bot reply in a chat the caller can open; the token is kept only as a hash. */
export async function createReplyShare(
  deps: { prisma: PrismaClient; webOrigin: string },
  actor: Actor,
  target: ThreadTarget,
  messageId: string,
): Promise<{ shareUrl: string }> {
  const message = await deps.prisma.message.findFirst({
    where: { id: messageId, threadId: target.threadId },
    select: { id: true, role: true, blocks: true, botId: true },
  });
  if (!message) throw new IsolationError();
  const botId = message.botId ?? (target.kind === "bot" ? target.botId : null);
  if (!botId || publicReplyText(message) === null) {
    throw new ClientError("BAD_REQUEST", "Only a bot reply with text can be shared.");
  }
  const token = randomBytes(32).toString("base64url");
  try {
    await deps.prisma.replyShare.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        messageId: message.id,
        botId,
        tokenHash: hashPageShareToken(token),
      },
    });
  } catch (error) {
    // The message, its bot or the caller's place in the Space went after the read above.
    if (isForeignKeyViolation(error)) throw new IsolationError();
    throw error;
  }
  return { shareUrl: replyShareUrl(deps.webOrigin, token) };
}

/** Every link the caller made, in any Space, newest first, with what each one shows. */
export async function listReplyShares(
  prisma: PrismaClient,
  actor: Actor,
): Promise<ReplyShareSummary[]> {
  const shares = await prisma.replyShare.findMany({
    where: { userId: actor.userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true, messageId: true, botId: true },
  });
  if (shares.length === 0) return [];
  // The caller's own links reach into every Space they share from, so their messages and bots
  // are read past the selected Space, by the ids of those links only.
  const [messages, bots] = await runAsSystem("reply share list", () =>
    Promise.all([
      prisma.message.findMany({
        where: { id: { in: shares.map((share) => share.messageId) } },
        select: { id: true, role: true, blocks: true },
      }),
      prisma.bot.findMany({
        where: { id: { in: shares.map((share) => share.botId) } },
        select: { id: true, name: true },
      }),
    ]),
  );
  const textById = new Map(messages.map((message) => [message.id, publicReplyText(message)]));
  const nameById = new Map(bots.map((bot) => [bot.id, bot.name]));
  return shares.flatMap((share) => {
    const text = textById.get(share.messageId);
    const botName = nameById.get(share.botId);
    if (!text || botName === undefined) return [];
    return [
      {
        id: share.id,
        botName,
        preview: truncatePlainText(text.replace(/\s+/g, " "), PREVIEW_CHARS),
        createdAt: share.createdAt.toISOString(),
      },
    ];
  });
}

/** Ends one of the caller's links; another person's link, or one already gone, is left as is. */
export async function removeReplyShare(prisma: PrismaClient, actor: Actor, shareId: string) {
  await prisma.replyShare.deleteMany({ where: { id: shareId, userId: actor.userId } });
  return { ok: true as const };
}

/** The reply a link opens, or null for any token that does not open one. */
export async function readSharedReply(
  prisma: PrismaClient,
  token: string,
): Promise<SharedReply | null> {
  if (!isReplyShareToken(token)) return null;
  const share = await runAsSystem("reply share link", () =>
    prisma.replyShare.findUnique({
      where: { tokenHash: hashPageShareToken(token) },
      select: {
        createdAt: true,
        bot: { select: { name: true } },
        message: { select: { id: true, role: true, blocks: true } },
      },
    }),
  );
  if (!share) return null;
  const text = publicReplyText(share.message);
  if (text === null) return null;
  return { botName: share.bot.name, text, sharedAt: share.createdAt.toISOString() };
}

/** Anyone with a reply's link reads it here, signed out. */
export function mountSharedReplies(
  app: Hono,
  prisma: PrismaClient,
  clientIp: (c: Context) => string | undefined,
) {
  mountShareLinkRead(app, SHARED_REPLY_PATH_PREFIX, clientIp, (token) =>
    readSharedReply(prisma, token),
  );
}
