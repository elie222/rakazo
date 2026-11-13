import type { PrismaClient } from "./client.js";
import { isSpaceOwner } from "./space-members.js";

/**
 * Unattended runs (webhooks, email, check-ins) act as a bot's creator, with their accounts. So
 * only the creator or the Space owner changes what a bot does; any member may rename it, restyle
 * it, pin it or move it to a section.
 */
const ANY_MEMBER_BOT_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "color",
  "avatarSet",
  "pinned",
  "sectionId",
]);

export const BOT_CHANGE_FORBIDDEN = "Only the bot's creator or the Space owner can change that.";

/** `code` lets a caller outside the RPC boundary answer FORBIDDEN as-is. */
export class BotChangeForbiddenError extends Error {
  readonly code = "FORBIDDEN";
  constructor() {
    super(BOT_CHANGE_FORBIDDEN);
    this.name = "BotChangeForbiddenError";
  }
}

/** Whether a change names any field beyond those every member may change. */
export function changesWhatBotDoes(changes: Record<string, unknown>): boolean {
  return Object.entries(changes).some(
    ([field, value]) =>
      value !== undefined && field !== "botId" && !ANY_MEMBER_BOT_FIELDS.has(field),
  );
}

/** The bot's creator or the Space owner. */
export async function canChangeBot(
  db: Pick<PrismaClient, "spaceMember">,
  actor: { spaceId: string; userId: string },
  bot: { userId: string },
): Promise<boolean> {
  return bot.userId === actor.userId || isSpaceOwner(db, actor);
}

export async function requireBotChange(
  db: Pick<PrismaClient, "spaceMember">,
  actor: { spaceId: string; userId: string },
  bot: { userId: string },
): Promise<void> {
  if (!(await canChangeBot(db, actor, bot))) throw new BotChangeForbiddenError();
}
