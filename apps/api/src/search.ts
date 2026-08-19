import type { Actor, MessageBlock, SearchHit } from "@rakazo/contracts";
import { extractLinksFromText, matchesSearchQuery, snippetAroundMatch } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";

const SEARCH_LIMIT = 25;

export async function queryWorkspaceSearch(
  prisma: PrismaClient,
  actor: Actor,
  q: string,
): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) return [];

  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  function push(hit: SearchHit) {
    const key = [
      hit.kind,
      hit.botId,
      hit.messageId ?? "",
      hit.artifactId ?? "",
      hit.routineId ?? "",
      hit.url ?? "",
    ].join(":");
    if (seen.has(key) || hits.length >= SEARCH_LIMIT) return;
    seen.add(key);
    hits.push(hit);
  }

  const bots = await prisma.bot.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      archivedAt: null,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { title: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
      ],
    },
    take: SEARCH_LIMIT,
  });
  for (const bot of bots) {
    push({
      kind: "conversation",
      botId: bot.id,
      botName: bot.name,
      title: bot.name,
      snippet: bot.title || bot.description || bot.name,
    });
  }

  const artifacts = await prisma.artifact.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      name: { contains: query, mode: "insensitive" },
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  for (const artifact of artifacts) {
    const messageRows = await prisma.$queryRaw<Array<{ id: string; seq: number }>>`
      SELECT m.id, m.seq
      FROM messages m
      INNER JOIN threads t ON t.id = m."threadId"
      WHERE t."workspaceId" = ${actor.workspaceId}
        AND t."userId" = ${actor.userId}
        AND t."botId" = ${artifact.botId}
        AND m.blocks::text ILIKE ${`%${artifact.id}%`}
      ORDER BY m."createdAt" DESC
      LIMIT 1
    `;
    const message = messageRows[0];
    if (!message) continue;
    push({
      kind: "file",
      botId: artifact.botId,
      botName: artifact.bot.name,
      title: artifact.name,
      snippet: `${artifact.mimeType} · ${artifact.size} bytes`,
      artifactId: artifact.id,
      messageId: message?.id,
      seq: message?.seq,
    });
  }

  const routines = await prisma.routine.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { prompt: { contains: query, mode: "insensitive" } },
      ],
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  for (const routine of routines) {
    push({
      kind: "routine",
      botId: routine.botId,
      botName: routine.bot.name,
      title: routine.name,
      snippet: snippetAroundMatch(routine.prompt, query),
      routineId: routine.id,
    });
  }

  const pattern = `%${query}%`;
  const messageRows = await prisma.$queryRaw<
    Array<{
      id: string;
      threadId: string;
      seq: number;
      blocks: Prisma.JsonValue;
      botId: string;
      botName: string;
    }>
  >`
    SELECT m.id, m."threadId", m.seq, m.blocks, b.id AS "botId", b.name AS "botName"
    FROM messages m
    INNER JOIN threads t ON t.id = m."threadId"
    INNER JOIN bots b ON b.id = t."botId"
    WHERE t."workspaceId" = ${actor.workspaceId}
      AND t."userId" = ${actor.userId}
      AND b."archivedAt" IS NULL
      AND m.blocks::text ILIKE ${pattern}
    ORDER BY m."createdAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `;

  for (const row of messageRows) {
    const blocks = row.blocks as MessageBlock[];
    let messageHit = false;
    for (const block of blocks) {
      if (block.kind !== "text") continue;
      const text = block.text;
      if (matchesSearchQuery(query, text)) {
        push({
          kind: "message",
          botId: row.botId,
          botName: row.botName,
          title: row.botName,
          snippet: snippetAroundMatch(text, query),
          messageId: row.id,
          seq: row.seq,
        });
        messageHit = true;
      }
      for (const url of extractLinksFromText(text)) {
        if (matchesSearchQuery(query, url)) {
          push({
            kind: "link",
            botId: row.botId,
            botName: row.botName,
            title: url,
            snippet: snippetAroundMatch(text, query),
            messageId: row.id,
            seq: row.seq,
            url,
          });
        }
      }
    }
    if (!messageHit && matchesSearchQuery(query, JSON.stringify(blocks))) {
      push({
        kind: "message",
        botId: row.botId,
        botName: row.botName,
        title: row.botName,
        snippet: query,
        messageId: row.id,
        seq: row.seq,
      });
    }
  }

  return hits.slice(0, SEARCH_LIMIT);
}
