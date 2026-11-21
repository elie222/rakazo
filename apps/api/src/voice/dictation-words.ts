import type { Actor } from "@rakazo/contracts";
import { extractLinksFromText } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  GUEST_ROLE,
  homeOrganizationId,
  newestMessagesOfActiveThreads,
  runAsSystem,
  storedMessageBlocks,
} from "@rakazo/db";

/** The phone's recognizer is tuned for a short list; past this, later names stop helping. */
const MAX_WORDS = 100;
/** The chats written to most recently and their latest messages: enough to see which
 * repositories keep coming up, in two indexed reads on every dictation. */
const RECENT_THREADS = 30;
const MESSAGES_PER_THREAD = 10;
const MAX_REPOSITORIES = 40;

/**
 * A page inside a code repository, as code hosts lay out their links: /owner/name/<section>.
 * A bare two-part path is not enough on its own: most sites use one for ordinary pages.
 */
const REPOSITORY_PATH =
  /^\/[\w.-]+\/([\w.-]+?)(?:\.git)?\/(?:pull|pulls|issues|tree|blob|commit|commits|compare|releases|actions|wiki)(?:\/|$)/;
/** The `owner/name#123` shorthand for an issue or pull request. */
const REPOSITORY_REFERENCE = /(?:^|[\s([`])[\w.-]+\/([\w.-]+)#\d+\b/g;

/** Repository names the texts link to or cite, most mentioned first. */
export function repositoryNames(texts: readonly string[]): string[] {
  const counts = new Map<string, number>();
  const count = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const text of texts) {
    for (const link of extractLinksFromText(text)) {
      const name = REPOSITORY_PATH.exec(URL.parse(link)?.pathname ?? "")?.[1];
      if (name) count(name);
    }
    for (const match of text.matchAll(REPOSITORY_REFERENCE)) {
      if (match[1]) count(match[1]);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_REPOSITORIES)
    .map(([name]) => name);
}

/**
 * Names the phone's recognizer should listen for when this member dictates: their own bots, the
 * people in their Spaces, and the repositories their own chats keep linking to.
 */
export function dictationWords(prisma: PrismaClient, actor: Actor): Promise<string[]> {
  return runAsSystem("dictation words from the member's Spaces", async () => {
    const organizationId = await homeOrganizationId(prisma, actor);
    const memberships = await prisma.spaceMember.findMany({
      where: { userId: actor.userId, OR: [{ organizationId }, { member: { role: GUEST_ROLE } }] },
      select: { spaceId: true },
    });
    const spaceIds = memberships.map((membership) => membership.spaceId);
    const [bots, members, messages] = await Promise.all([
      prisma.bot.findMany({
        where: { spaceId: { in: spaceIds }, userId: actor.userId, archivedAt: null },
        select: { name: true },
      }),
      prisma.spaceMember.findMany({
        where: { spaceId: { in: spaceIds } },
        select: { member: { select: { user: { select: { name: true } } } } },
      }),
      newestMessagesOfActiveThreads(
        prisma,
        { userId: actor.userId, spaceIds },
        RECENT_THREADS,
        MESSAGES_PER_THREAD,
      ),
    ]);
    const texts = messages.flatMap((message) =>
      storedMessageBlocks(message).flatMap((block) => (block.kind === "text" ? [block.text] : [])),
    );
    const named = [...bots.map((bot) => bot.name), ...members.map((row) => row.member.user.name)]
      .map((name) => name.trim())
      .filter(Boolean);
    // A repository a bot or person shares a name with takes their spelling ("PlatoChat").
    const spelling = new Map<string, string>();
    // Bots come before members, so a bot keeps its spelling over a member of the same name.
    for (const name of named) {
      if (!spelling.has(name.toLowerCase())) spelling.set(name.toLowerCase(), name);
    }
    const words = new Map<string, string>();
    // Repositories come first, so a Space's member list cannot crowd them out.
    for (const word of [
      ...repositoryNames(texts).map((name) => spelling.get(name.toLowerCase()) ?? name),
      ...named,
    ]) {
      const key = word.toLowerCase();
      if (!words.has(key)) words.set(key, word);
    }
    return [...words.values()].slice(0, MAX_WORDS);
  });
}
