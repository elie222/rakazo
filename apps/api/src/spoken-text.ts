import type { MessageBlock } from "@rakazo/contracts";
import { speakable, speechFromBlocks } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

export type SpokenTextResolver = (input: {
  prisma: PrismaClient;
  botId: string;
  threadId: string;
  messageId: string;
  blocks: MessageBlock[];
}) => Promise<string>;

export type HostSpeaker = (input: {
  prisma: PrismaClient;
  botId: string;
  text: string;
  speakOnHost: boolean;
}) => Promise<boolean>;

let spokenTextResolver: SpokenTextResolver | null = null;
const hostSpeakers = new WeakMap<object, HostSpeaker>();

/** Optional reply-text override. Unset, the spoken line is the full reply. */
export function registerSpokenTextResolver(fn: SpokenTextResolver): void {
  spokenTextResolver = fn;
}

/** Optional host playback, keyed by the router deps object. Unset, the browser speaks. */
export function registerHostSpeaker(key: object, fn: HostSpeaker): void {
  hostSpeakers.set(key, fn);
}

/**
 * A reply the actor may speak. Direct replies live on the bot's thread. Group
 * replies live on the group thread and carry the speaking bot's id.
 */
export async function loadSpeakableMessage(
  prisma: PrismaClient,
  actor: { spaceId: string; userId: string },
  input: { botId: string; messageId: string },
): Promise<{ threadId: string; blocks: MessageBlock[] }> {
  const bot = await prisma.bot.findFirst({
    where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, thread: { select: { id: true } } },
  });
  if (!bot) throw new IsolationError();
  const message = await prisma.message.findFirst({
    where: { id: input.messageId, role: "bot" },
    select: {
      blocks: true,
      botId: true,
      thread: {
        select: {
          id: true,
          spaceId: true,
          userId: true,
          botId: true,
          group: { select: { members: { where: { botId: bot.id }, select: { botId: true } } } },
        },
      },
    },
  });
  const thread = message?.thread;
  if (!message || !thread) throw new IsolationError();
  const owned =
    thread.spaceId === actor.spaceId &&
    thread.userId === actor.userId &&
    (thread.botId === bot.id
      ? !message.botId || message.botId === bot.id
      : (thread.group?.members.length ?? 0) > 0 && message.botId === bot.id);
  if (!owned) throw new IsolationError();
  return { threadId: thread.id, blocks: message.blocks as MessageBlock[] };
}

export async function resolveSpokenText(input: {
  prisma: PrismaClient;
  botId: string;
  threadId: string;
  messageId: string;
  blocks: MessageBlock[];
}): Promise<string> {
  if (spokenTextResolver) return spokenTextResolver(input);
  return speakable(speechFromBlocks(input.blocks));
}

export async function speakOnHost(
  key: object,
  input: {
    prisma: PrismaClient;
    botId: string;
    text: string;
    speakOnHost: boolean;
  },
): Promise<boolean> {
  const speaker = hostSpeakers.get(key);
  if (!speaker) return false;
  return speaker(input);
}
