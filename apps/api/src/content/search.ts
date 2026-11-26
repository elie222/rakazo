import type { Actor, MessageBlock, SearchHit } from "@rakazo/contracts";
import { GROUP_MEMBER_MIN } from "@rakazo/contracts";
import {
  displayName,
  escapeJsonSearchWildcards,
  escapeSearchWildcards,
  extractLinksFromText,
  matchesSearchQuery,
  snippetAroundMatch,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  contentEncryptionOf,
  INDEXED_MESSAGE,
  LISTED_ARTIFACT,
  Prisma,
  storedMessageBlocks,
  UNINDEXED_MESSAGE,
} from "@rakazo/db";

const SEARCH_LIMIT = 25;
/** Cap name matches so content hits (messages/files/links/routines) keep most of the budget. */
const CONVERSATION_HIT_LIMIT = 5;
/** Recent encrypted messages scanned when no query term is long enough to be indexed. */
const UNINDEXED_SCAN_LIMIT = 200;

/**
 * A delivery is the bot's prompt, hidden in chat, so it is never a result. Filtered before
 * paging so deliveries can't fill the candidate pages; `kind` stays plaintext when encrypted.
 */
const NOT_DELIVERY = Prisma.sql`NOT (m.blocks @> ${JSON.stringify([{ kind: "delivery" }])}::jsonb)`;

interface MessageMatch {
  sql: Prisma.Sql;
  pairs?: Prisma.Sql;
  limit: number;
  pages: number;
}

async function messageMatch(
  prisma: PrismaClient,
  spaceId: string,
  query: string,
): Promise<MessageMatch> {
  const plaintext = Prisma.sql`m.blocks::text ILIKE ${`%${escapeJsonSearchWildcards(query)}%`}`;
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) return { sql: plaintext, limit: SEARCH_LIMIT, pages: 1 };
  const [prefixTokens, pairTokens] = await Promise.all([
    encryption.messageSearchTokens(spaceId, query, "prefix"),
    encryption.messageSearchTokens(spaceId, query, "han-pair"),
  ]);
  // No keys: nothing in the space was ever encrypted (encryption off from the start).
  if (!prefixTokens.length) return { sql: plaintext, limit: SEARCH_LIMIT, pages: 1 };
  const indexed = (sets: number[][]) =>
    sets
      .filter((tokens) => tokens.length)
      .map((tokens) => Prisma.sql`m."searchTokens" @> ${tokens}::int[]`);
  const prefixes = indexed(prefixTokens);
  const pairs = indexed(pairTokens);
  if (!prefixes.length && !pairs.length)
    return {
      sql: Prisma.sql`(${INDEXED_MESSAGE} OR ${plaintext})`,
      limit: UNINDEXED_SCAN_LIMIT,
      pages: 1,
    };
  return {
    sql: Prisma.sql`(${Prisma.join([...prefixes, Prisma.sql`(${UNINDEXED_MESSAGE} AND ${plaintext})`], " OR ")})`,
    pairs: pairs.length ? Prisma.sql`(${Prisma.join(pairs, " OR ")})` : undefined,
    limit: SEARCH_LIMIT * 4,
    // Candidates can share the query's tokens without containing the phrase.
    pages: 5,
  };
}

interface MessageScope {
  destination: Prisma.Sql;
  from: Prisma.Sql;
}

interface SearchMessage {
  id: string;
  threadId: string;
  seq: number;
  blocks: Prisma.JsonValue;
  botId?: string;
  botName?: string;
  groupId?: string;
  groupName?: string;
}

async function* messagePages(
  prisma: PrismaClient,
  match: MessageMatch,
  scope: MessageScope,
  signal?: AbortSignal,
) {
  const select = Prisma.sql`SELECT m.id, m."threadId", m.seq, m.blocks, ${scope.destination}`;
  const order = Prisma.sql`ORDER BY m."createdAt" DESC, m.id DESC`;
  const encryption = contentEncryptionOf(prisma);
  const open = async (rows: SearchMessage[]) =>
    (await encryption?.openRows("Message", rows)) ?? rows;
  if (!match.pairs) {
    for (let page = 0; page < match.pages; page++) {
      signal?.throwIfAborted();
      const rows = await prisma.$queryRaw<SearchMessage[]>(Prisma.sql`
        ${select} ${scope.from} AND ${match.sql} ${order}
        LIMIT ${match.limit} OFFSET ${page * match.limit}`);
      signal?.throwIfAborted();
      yield await open(rows);
      if (rows.length < match.limit) break;
    }
    return;
  }

  // Limit both predicates independently, then deduplicate the selected IDs.
  // A match can be outside the prefix window and inside the pair window.
  signal?.throwIfAborted();
  const budget = match.limit * match.pages;
  const window = (predicate: Prisma.Sql) => Prisma.sql`
    (SELECT m.id, m."createdAt" ${scope.from} AND ${predicate} ${order} LIMIT ${budget})`;
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM (${window(match.sql)} UNION ${window(match.pairs)}) candidates
    ORDER BY "createdAt" DESC, id DESC`);
  for (let offset = 0; offset < candidates.length; offset += match.limit) {
    signal?.throwIfAborted();
    const ids = candidates.slice(offset, offset + match.limit).map(({ id }) => id);
    const rows = await prisma.$queryRaw<SearchMessage[]>(Prisma.sql`
      ${select} ${scope.from} AND m.id = ANY(${ids}::text[])
      ORDER BY array_position(${ids}::text[], m.id)`);
    signal?.throwIfAborted();
    yield await open(rows);
  }
}

async function findArtifactMessages(
  prisma: PrismaClient,
  actor: Actor,
  artifacts: Array<{ id: string; targetId: string }>,
  target: "bot" | "group",
): Promise<Map<string, { id: string; seq: number }>> {
  if (artifacts.length === 0) return new Map();
  const targetColumn = target === "bot" ? Prisma.sql`t."botId"` : Prisma.sql`t."groupId"`;
  const candidates = Prisma.join(
    artifacts.map(({ id, targetId }) => Prisma.sql`(${id}, ${targetId})`),
  );
  const rows = await prisma.$queryRaw<Array<{ artifactId: string; id: string; seq: number }>>(
    Prisma.sql`
      SELECT candidate."artifactId", message.id, message.seq
      FROM (VALUES ${candidates}) AS candidate("artifactId", "targetId")
      CROSS JOIN LATERAL (
        SELECT m.id, m.seq
        FROM messages m
        INNER JOIN threads t ON t.id = m."threadId"
        WHERE t."spaceId" = ${actor.spaceId}
          AND ${targetColumn} = candidate."targetId"
          AND m.blocks::text ILIKE ('%' || candidate."artifactId" || '%')
        ORDER BY m."createdAt" DESC
        LIMIT 1
      ) message
    `,
  );
  return new Map(rows.map(({ artifactId, id, seq }) => [artifactId, { id, seq }]));
}

export async function querySpaceSearch(
  prisma: PrismaClient,
  actor: Actor,
  q: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) return [];
  // The database side has to match the text the user typed, the way
  // `matchesSearchQuery` does in memory: a `%` or `_` would otherwise widen
  // the match, and a `\` would swallow the character after it.
  const likeQuery = escapeSearchWildcards(query);

  const conversationHits: SearchHit[] = [];
  const contentHits: SearchHit[] = [];
  const seen = new Set<string>();

  function pushInto(bucket: SearchHit[], hit: SearchHit, limit: number) {
    const key = [
      hit.kind,
      hit.botId ?? "",
      hit.groupId ?? "",
      hit.messageId ?? "",
      hit.artifactId ?? "",
      hit.routineId ?? "",
      hit.url ?? "",
    ].join(":");
    if (seen.has(key) || bucket.length >= limit) return;
    seen.add(key);
    bucket.push(hit);
  }

  signal?.throwIfAborted();
  const bots = await prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      archivedAt: null,
      OR: [
        { name: { contains: likeQuery, mode: "insensitive" } },
        { description: { contains: likeQuery, mode: "insensitive" } },
      ],
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const bot of bots) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        botId: bot.id,
        botName: bot.name,
        title: bot.name,
        snippet: bot.description || displayName(bot.name, ""),
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  // Only groups that can actually be opened: not archived, and still holding
  // enough active-member bots (archiving bots can empty a group below the
  // minimum — those land on the Archived list instead of opening).
  signal?.throwIfAborted();
  const openableGroups = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT g.id FROM chat_groups g
      WHERE g."spaceId" = ${actor.spaceId}
        AND g."archivedAt" IS NULL
        AND (
          SELECT COUNT(*) FROM chat_group_members gm
          INNER JOIN bots gb ON gb.id = gm."botId"
          WHERE gm."groupId" = g.id AND gb."archivedAt" IS NULL
        ) >= ${GROUP_MEMBER_MIN}
    `,
  );
  const openableGroupIds = openableGroups.map(({ id }) => id);
  const groups = await prisma.chatGroup.findMany({
    where: {
      spaceId: actor.spaceId,
      id: { in: openableGroupIds },
      name: { contains: likeQuery, mode: "insensitive" },
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const group of groups) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        groupId: group.id,
        groupName: group.name,
        title: group.name,
        snippet: displayName(group.name, ""),
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  const contentBudget = Math.max(0, SEARCH_LIMIT - conversationHits.length);
  const full = () => contentHits.length >= contentBudget;

  signal?.throwIfAborted();
  const artifacts = await prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      groupId: null,
      botId: { not: null },
      name: { contains: likeQuery, mode: "insensitive" },
      bot: { archivedAt: null },
      ...LISTED_ARTIFACT,
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const botArtifactMessages = await findArtifactMessages(
    prisma,
    actor,
    artifacts.flatMap((artifact) =>
      artifact.botId && artifact.bot ? [{ id: artifact.id, targetId: artifact.botId }] : [],
    ),
    "bot",
  );
  for (const artifact of artifacts) {
    if (!artifact.botId || !artifact.bot) continue;
    const message = botArtifactMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        botId: artifact.botId,
        botName: artifact.bot.name,
        title: artifact.name,
        snippet: `${artifact.mimeType}, ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  if (full()) return [...conversationHits, ...contentHits];

  signal?.throwIfAborted();
  const groupArtifacts = await prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      groupId: { in: openableGroupIds },
      name: { contains: likeQuery, mode: "insensitive" },
      ...LISTED_ARTIFACT,
    },
    include: { group: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const groupArtifactMessages = await findArtifactMessages(
    prisma,
    actor,
    groupArtifacts.flatMap((artifact) =>
      artifact.groupId && artifact.group ? [{ id: artifact.id, targetId: artifact.groupId }] : [],
    ),
    "group",
  );
  for (const artifact of groupArtifacts) {
    if (!artifact.groupId || !artifact.group) continue;
    const message = groupArtifactMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        groupId: artifact.groupId,
        groupName: artifact.group.name,
        title: artifact.name,
        snippet: `${artifact.mimeType}, ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  if (full()) return [...conversationHits, ...contentHits];

  signal?.throwIfAborted();
  const routines = await prisma.routine.findMany({
    where: {
      spaceId: actor.spaceId,
      OR: [
        { name: { contains: likeQuery, mode: "insensitive" } },
        { prompt: { contains: likeQuery, mode: "insensitive" } },
      ],
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  for (const routine of routines) {
    pushInto(
      contentHits,
      {
        kind: "routine",
        botId: routine.botId,
        botName: routine.bot.name,
        title: routine.name,
        snippet: snippetAroundMatch(routine.prompt, query),
        routineId: routine.id,
      },
      contentBudget,
    );
  }

  if (full()) return [...conversationHits, ...contentHits];

  signal?.throwIfAborted();
  const match = await messageMatch(prisma, actor.spaceId, query);
  const scopes: MessageScope[] = [
    {
      destination: Prisma.sql`b.id AS "botId", b.name AS "botName"`,
      from: Prisma.sql`
        FROM messages m
        INNER JOIN threads t ON t.id = m."threadId"
        INNER JOIN bots b ON b.id = t."botId" AND b."spaceId" = t."spaceId"
        WHERE t."spaceId" = ${actor.spaceId} AND b."archivedAt" IS NULL AND ${NOT_DELIVERY}`,
    },
    {
      destination: Prisma.sql`g.id AS "groupId", g.name AS "groupName"`,
      from: Prisma.sql`
        FROM messages m
        INNER JOIN threads t ON t.id = m."threadId"
        INNER JOIN chat_groups g ON g.id = t."groupId" AND g."spaceId" = t."spaceId"
        WHERE t."spaceId" = ${actor.spaceId}
          AND g.id IN (${Prisma.join(openableGroupIds.length ? openableGroupIds : [null])})
          AND ${NOT_DELIVERY}`,
    },
  ];
  for (const scope of scopes) {
    for await (const rows of messagePages(prisma, match, scope, signal)) {
      for (const row of rows) {
        pushMessageHits(storedMessageBlocks(row), {
          botId: row.botId,
          botName: row.botName,
          groupId: row.groupId,
          groupName: row.groupName,
          messageId: row.id,
          seq: row.seq,
          query,
          push: (hit) => pushInto(contentHits, hit, contentBudget),
        });
      }
      if (full()) return [...conversationHits, ...contentHits];
    }
  }

  return [...conversationHits, ...contentHits].slice(0, SEARCH_LIMIT);
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
  // Discriminate on groupId (not name): empty group names must still target the group.
  const destination = ctx.groupId
    ? { groupId: ctx.groupId, groupName: ctx.groupName ?? "" }
    : { botId: ctx.botId!, botName: ctx.botName! };
  const title = ctx.groupId ? (ctx.groupName ?? "") : (ctx.botName ?? "");
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
