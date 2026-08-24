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
      hit.botId ?? "",
      hit.groupId ?? "",
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

  const groups = await prisma.chatGroup.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      name: { contains: query, mode: "insensitive" },
    },
    take: SEARCH_LIMIT,
  });
  const groupConversationHits: SearchHit[] = [];
  for (const group of groups) {
    groupConversationHits.push({
      kind: "conversation",
      groupId: group.id,
      groupName: group.name,
      title: group.name,
      snippet: group.name,
    });
  }

  const artifacts = await prisma.artifact.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      groupId: null,
      name: { contains: query, mode: "insensitive" },
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  for (const artifact of artifacts) {
    if (!artifact.botId || !artifact.bot) continue;
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

  const groupArtifacts = await prisma.artifact.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      groupId: { not: null },
      name: { contains: query, mode: "insensitive" },
    },
    include: { group: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  for (const artifact of groupArtifacts) {
    if (!artifact.groupId || !artifact.group) continue;
    const messageRows = await prisma.$queryRaw<Array<{ id: string; seq: number }>>`
      SELECT m.id, m.seq
      FROM messages m
      INNER JOIN threads t ON t.id = m."threadId"
      WHERE t."workspaceId" = ${actor.workspaceId}
        AND t."userId" = ${actor.userId}
        AND t."groupId" = ${artifact.groupId}
        AND m.blocks::text ILIKE ${`%${artifact.id}%`}
      ORDER BY m."createdAt" DESC
      LIMIT 1
    `;
    const message = messageRows[0];
    if (!message) continue;
    push({
      kind: "file",
      groupId: artifact.groupId,
      groupName: artifact.group.name,
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
    pushMessageHits(row.blocks as MessageBlock[], {
      botId: row.botId,
      botName: row.botName,
      messageId: row.id,
      seq: row.seq,
      query,
      push,
    });
  }

  const groupMessageRows = await prisma.$queryRaw<
    Array<{
      id: string;
      threadId: string;
      seq: number;
      blocks: Prisma.JsonValue;
      groupId: string;
      groupName: string;
    }>
  >`
    SELECT m.id, m."threadId", m.seq, m.blocks, g.id AS "groupId", g.name AS "groupName"
    FROM messages m
    INNER JOIN threads t ON t.id = m."threadId"
    INNER JOIN chat_groups g ON g.id = t."groupId"
    WHERE t."workspaceId" = ${actor.workspaceId}
      AND t."userId" = ${actor.userId}
      AND t."groupId" IS NOT NULL
      AND m.blocks::text ILIKE ${pattern}
    ORDER BY m."createdAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `;

  for (const row of groupMessageRows) {
    pushMessageHits(row.blocks as MessageBlock[], {
      groupId: row.groupId,
      groupName: row.groupName,
      messageId: row.id,
      seq: row.seq,
      query,
      push,
    });
  }

  for (const hit of groupConversationHits) {
    push(hit);
  }

  return hits.slice(0, SEARCH_LIMIT);
}

function pushMessageHits(
  blocks: MessageBlock[],
  ctx: {
    botId?: string;
    botName?: string;
    groupId?: string;
    groupName?: string;
    messageId: string;
    seq: number;
    query: string;
    push: (hit: SearchHit) => void;
  },
) {
  const destination =
    ctx.groupId && ctx.groupName
      ? { groupId: ctx.groupId, groupName: ctx.groupName }
      : { botId: ctx.botId!, botName: ctx.botName! };
  const title = ctx.groupName ?? ctx.botName ?? "";
  let messageHit = false;
  for (const block of blocks) {
    if (block.kind !== "text") continue;
    const text = block.text;
    if (matchesSearchQuery(ctx.query, text)) {
      ctx.push({
        kind: "message",
        ...destination,
        title,
        snippet: snippetAroundMatch(text, ctx.query),
        messageId: ctx.messageId,
        seq: ctx.seq,
      });
      messageHit = true;
    }
    for (const url of extractLinksFromText(text)) {
      if (matchesSearchQuery(ctx.query, url)) {
        ctx.push({
          kind: "link",
          ...destination,
          title: url,
          snippet: snippetAroundMatch(text, ctx.query),
          messageId: ctx.messageId,
          seq: ctx.seq,
          url,
        });
      }
    }
  }
  if (!messageHit && matchesSearchQuery(ctx.query, JSON.stringify(blocks))) {
    ctx.push({
      kind: "message",
      ...destination,
      title,
      snippet: ctx.query,
      messageId: ctx.messageId,
      seq: ctx.seq,
    });
  }
}
