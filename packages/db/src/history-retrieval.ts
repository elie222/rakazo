import { createHash } from "node:crypto";
import type { HistoryReadInput, HistorySearchInput, MessageBlock } from "@rakazo/contracts";
import { HistoryQueriesSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

/** External text claimed mid-turn permanently removes owner-only capabilities for this run. */
export async function hasClaimedExternalSteering(
  prisma: PrismaClient,
  runId: string,
): Promise<boolean> {
  return Boolean(
    await prisma.steeringMessage.findFirst({
      where: {
        runId,
        claimedAt: { not: null },
        OR: [
          { originTrigger: { not: null } },
          { message: { blocks: { array_contains: [{ kind: "channel_message" }] } } },
        ],
      },
      select: { id: true },
    }),
  );
}

/** Only the executor supplies scope; tool arguments cannot widen it. */
export interface HistoryScope {
  spaceId: string;
  userId: string;
  threadId: string;
  botId: string;
  channelId?: string;
  /** Executor-only grant: direct human app runs, never external or background runs. */
  allowMyChats?: boolean;
  searchAt?: Date;
  /** Server-captured history boundary. Search excludes the active request and later messages. */
  searchBeforeSeq?: number;
}
interface HistoryRow {
  id: string;
  seq: number;
  role: string;
  runId: string | null;
  replyToMessageId: string | null;
  createdAt: Date;
  blocks: Prisma.JsonValue;
  groupId?: string | null;
  threadId?: string;
  botId?: string | null;
  chatName?: string;
  matchedQueryIndexes?: number[];
}
// Bound complete JSON pages, including cursors. Current retains Pi's legacy 12k
// result clipping; newer strategies preserve structured results within their context budget.
const MAX_RESPONSE_BYTES = 10_000;
const LINK_PAGE_SIZE = 5;
function bounded<T extends { messages: ReturnType<typeof reference>[] }>(response: T): T {
  const refs = [...response.messages];
  if ("runs" in response) {
    const runs = response.runs as Array<{
      outcomes: ReturnType<typeof reference>[];
    }>;
    refs.push(...runs.flatMap((run) => run.outcomes));
  }
  while (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_RESPONSE_BYTES) {
    const longest = refs.reduce<ReturnType<typeof reference> | undefined>(
      (best, ref) => (!best || ref.text.length > best.text.length ? ref : best),
      undefined,
    );
    if (!longest || longest.text.length < 2)
      throw new Error("History metadata exceeds response budget");
    longest.text = longest.text.slice(0, Math.floor(longest.text.length / 2));
    longest.truncated = true;
    longest.nextTextOffset = longest.textOffset + longest.text.length;
  }
  return response;
}
const searchableText = Prisma.sql`jsonb_path_query_array(m.blocks,
  '$[*] ? (@.kind == "text" || @.kind == "channel_message" || @.kind == "bot_message_received" || @.kind == "bot_message_sent" || @.kind == "handoff").text')::text || jsonb_path_query_array(m.blocks, '$[*] ? (@.kind == "subagent").task')::text || jsonb_path_query_array(m.blocks, '$[*] ? (@.kind == "subagent").result')::text`;
const columns = Prisma.sql`m.id, m.seq, m.role, m."runId", m."replyToMessageId", m."createdAt", m.blocks, t."groupId" AS "groupId"`;

function visible(scope: HistoryScope, myChats = false, targetThreadId?: string): Prisma.Sql {
  if (myChats)
    return Prisma.sql`
    t."spaceId" = ${scope.spaceId} AND t."userId" = ${scope.userId}
    ${targetThreadId ? Prisma.sql`AND t.id = ${targetThreadId}` : Prisma.empty}
    AND ((t."groupId" IS NULL AND EXISTS (
      SELECT 1 FROM bots b WHERE b.id = t."botId" AND b."spaceId" = ${scope.spaceId}
        AND b."userId" = ${scope.userId} AND b."archivedAt" IS NULL
    )) OR (t."botId" IS NULL AND EXISTS (
      SELECT 1 FROM chat_groups g WHERE g.id = t."groupId" AND g."spaceId" = ${scope.spaceId}
        AND g."userId" = ${scope.userId} AND g."archivedAt" IS NULL
    )))`;

  const channel = scope.channelId;
  return Prisma.sql`
    t.id = ${scope.threadId} AND t."spaceId" = ${scope.spaceId}
    AND t."userId" = ${scope.userId}
    AND (t."botId" = ${scope.botId} OR (t."botId" IS NULL AND EXISTS (
      SELECT 1 FROM chat_groups g JOIN chat_group_members member ON member."groupId" = g.id
      WHERE g.id = t."groupId" AND g."spaceId" = ${scope.spaceId} AND g."userId" = ${scope.userId}
        AND g."archivedAt" IS NULL AND member."botId" = ${scope.botId}
    )))
    AND EXISTS (SELECT 1 FROM bots b WHERE b.id = ${scope.botId}
      AND b."spaceId" = ${scope.spaceId} AND b."userId" = ${scope.userId}
      AND b."archivedAt" IS NULL)
    ${
      channel
        ? Prisma.sql`AND (
      (m.role = 'user' AND m.blocks @> ${JSON.stringify([{ kind: "channel_message", channelId: channel }])}::jsonb)
      OR (m.role = 'bot' AND EXISTS (
        SELECT 1 FROM runs r JOIN messages source ON source.id = r."sourceMessageId"
        WHERE r.id = m."runId" AND r."threadId" = t.id
          AND r."spaceId" = ${scope.spaceId} AND r."userId" = ${scope.userId}
          AND r."botId" = ${scope.botId} AND source."threadId" = t.id
          AND source.blocks @> ${JSON.stringify([{ kind: "channel_message", channelId: channel }])}::jsonb
      )))`
        : Prisma.empty
    }
  `;
}
function pageSize(value = 10): number {
  if (!Number.isInteger(value) || value < 1)
    throw new Error("History limit must be a positive integer");
  return Math.min(value, 20);
}
function date(value: string | undefined): Date | undefined {
  if (value === undefined) return;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid history date");
  return parsed;
}
/** Text only: progress, commands, secret prompts and tool traces are not retrieval content. */
export function historyMessageText(blocks: Prisma.JsonValue): string {
  if (!Array.isArray(blocks)) return "";
  return (
    blocks.filter(
      (block) => block && typeof block === "object" && !Array.isArray(block),
    ) as MessageBlock[]
  )
    .flatMap((block) => {
      if (block.kind === "subagent") return [block.task, block.result ?? ""].filter(Boolean);
      return [
        "text",
        "channel_message",
        "bot_message_received",
        "bot_message_sent",
        "handoff",
      ].includes(block.kind) &&
        "text" in block &&
        typeof block.text === "string"
        ? [block.text]
        : [];
    })
    .join("\n");
}
function reference(row: HistoryRow, query = "", maxLength = 800, textOffset = 0) {
  const text = historyMessageText(row.blocks);
  const matchedTerm =
    query && !text.toLowerCase().includes(query.toLowerCase())
      ? (query.split(/\s+/).find((term) => text.toLowerCase().includes(term.toLowerCase())) ??
        query)
      : query;
  if (query) textOffset = Math.max(0, text.toLowerCase().indexOf(matchedTerm.toLowerCase()) - 40);
  return {
    messageId: row.id,
    seq: row.seq,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    runId: row.runId,
    replyToMessageId: row.replyToMessageId,
    text: text.slice(textOffset, textOffset + maxLength),
    textOffset,
    nextTextOffset: textOffset + maxLength < text.length ? textOffset + maxLength : null,
    truncated: textOffset > 0 || textOffset + maxLength < text.length,
  };
}

/** Indexed full text search: legacy sequence pages, or ranked multi-query/chat pages. */
export async function searchHistory(
  prisma: PrismaClient,
  scope: HistoryScope,
  input: HistorySearchInput,
) {
  const queries =
    input.queries === undefined
      ? [input.query?.trim() ?? ""]
      : HistoryQueriesSchema.parse(input.queries);
  const query = queries[0]!;
  if (
    (input.query !== undefined) === (input.queries !== undefined) ||
    queries.length < 1 ||
    queries.length > 5 ||
    queries.some((query) => !query || query.length > 500)
  )
    throw new Error("History query must contain 1 to 500 characters");
  const myChats = input.scope === "my_chats";
  if (myChats && (!scope.allowMyChats || scope.channelId))
    throw new Error("my_chats is available only in direct human app runs; use this_chat.");
  const ranked = myChats || input.queries !== undefined;
  const limit = Math.min(pageSize(input.limit), 5);
  const before = date(input.before);
  const after = date(input.after);
  if (
    input.beforeSeq !== undefined &&
    (!Number.isInteger(input.beforeSeq) || input.beforeSeq < 0)
  ) {
    throw new Error("Invalid history cursor");
  }
  if (
    scope.searchBeforeSeq !== undefined &&
    (!Number.isInteger(scope.searchBeforeSeq) || scope.searchBeforeSeq < 0)
  )
    throw new Error("Invalid history search boundary");
  const beforeSeq = Math.min(
    input.beforeSeq ?? Number.POSITIVE_INFINITY,
    scope.searchBeforeSeq ?? Number.POSITIVE_INFINITY,
  );
  const kinds = input.kinds;
  const kindFilter = kinds
    ? Prisma.sql`AND (${Prisma.join(
        kinds.map((kind) =>
          kind === "bot_messages"
            ? Prisma.sql`jsonb_path_exists(m.blocks, '$[*] ? (@.kind == "bot_message_sent" || @.kind == "bot_message_received" || @.kind == "handoff")')`
            : kind === "user_messages"
              ? Prisma.sql`m.role = 'user' AND jsonb_path_exists(m.blocks, '$[*] ? (@.kind == "text" || @.kind == "channel_message")')`
              : Prisma.sql`m.role = 'bot' AND jsonb_path_exists(m.blocks, '$[*] ? (@.kind == "text")')`,
        ),
        " OR ",
      )})`
    : Prisma.empty;
  const filters = Prisma.sql`
    ${visible(scope, myChats)}
    ${
      input.botId
        ? Prisma.sql`AND (t."botId" = ${input.botId} OR EXISTS (
      SELECT 1 FROM chat_group_members member JOIN bots b ON b.id = member."botId"
      WHERE member."groupId" = t."groupId" AND b.id = ${input.botId}
        AND b."spaceId" = ${scope.spaceId} AND b."userId" = ${scope.userId} AND b."archivedAt" IS NULL
    ))`
        : Prisma.empty
    }
    ${kindFilter}
    ${before ? Prisma.sql`AND m."createdAt" < ${before}` : Prisma.empty}
    ${after ? Prisma.sql`AND m."createdAt" >= ${after}` : Prisma.empty}
    ${Number.isFinite(beforeSeq) ? Prisma.sql`AND (t.id <> ${scope.threadId} OR m.seq < ${beforeSeq})` : Prisma.empty}
    ${myChats && scope.searchAt ? Prisma.sql`AND m."createdAt" < ${scope.searchAt}` : Prisma.empty}`;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000)
    throw new Error("Invalid history offset");
  const rows = ranked
    ? await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
      SELECT ${columns}, t.id AS "threadId", t."botId", COALESCE(b.name, g.name) AS "chatName",
        matches."matchedQueryIndexes"
      FROM messages m JOIN threads t ON t.id = m."threadId"
      LEFT JOIN bots b ON b.id = t."botId" LEFT JOIN chat_groups g ON g.id = t."groupId"
      JOIN LATERAL (
        SELECT array_agg(q.n ORDER BY q.n) AS "matchedQueryIndexes",
          max(ts_rank(to_tsvector('simple', ${searchableText}), plainto_tsquery('simple', q.query))) AS rank
        FROM (VALUES ${Prisma.join(queries.map((query, index) => Prisma.sql`(${query}::text, ${index}::integer)`))}) q(query, n)
        WHERE to_tsvector('simple', ${searchableText}) @@ plainto_tsquery('simple', q.query)
      ) matches ON matches.rank IS NOT NULL
      WHERE ${filters}
        AND (${Prisma.join(
          queries.map(
            (query) =>
              Prisma.sql`to_tsvector('simple', ${searchableText}) @@ plainto_tsquery('simple', ${query})`,
          ),
          " OR ",
        )})
      ORDER BY matches.rank * (1 + 0.1 / (1 + GREATEST(EXTRACT(EPOCH FROM (${scope.searchAt ?? new Date()}::timestamptz - m."createdAt")) / 86400, 0) / 30)) DESC,
        m."createdAt" DESC, m.id DESC
      LIMIT ${limit + 1} OFFSET ${offset}`)
    : await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
      SELECT ${columns} FROM messages m JOIN threads t ON t.id = m."threadId"
      WHERE ${filters}
        AND to_tsvector('simple', ${searchableText}) @@ plainto_tsquery('simple', ${query})
      ORDER BY m.seq DESC LIMIT ${limit + 1}`);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const capped = ranked && offset + limit > 10000;
  const nextBeforeSeq = !ranked && hasMore ? page.at(-1)!.seq : null;
  const messages = page.map((row) => ({
    ...reference(row, queries[row.matchedQueryIndexes?.[0] ?? 0]),
    ...(ranked ? { threadId: row.threadId, matchedQueryIndexes: row.matchedQueryIndexes } : {}),
  }));
  return bounded({
    untrusted: true as const,
    query: ranked ? undefined : query,
    ...(ranked ? { queries } : {}),
    ...(ranked
      ? {
          chats: [...new Set(page.map((row) => row.threadId))].map((threadId) => {
            const hits = page.filter((row) => row.threadId === threadId);
            return {
              threadId,
              name: hits[0]?.chatName,
              lastHitAt: hits
                .reduce(
                  (latest, row) => (row.createdAt > latest ? row.createdAt : latest),
                  hits[0]!.createdAt,
                )
                .toISOString(),
              messageIds: hits.map((row) => row.id),
            };
          }),
        }
      : {}),
    coverage: {
      scope: "requested_query_and_range" as const,
      status: !hasMore ? ("exhausted" as const) : ("partial" as const),
      ...(capped && hasMore ? { capped: true } : {}),
    },
    messages,
    nextBeforeSeq,
    nextSearch:
      !hasMore || capped
        ? null
        : {
            ...(input.queries ? { queries } : { query }),
            ...(ranked
              ? {
                  offset: offset + limit,
                  ...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}),
                }
              : { beforeSeq: nextBeforeSeq! }),
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.botId ? { botId: input.botId } : {}),
            ...(input.kinds ? { kinds: input.kinds } : {}),
            limit,
            ...(input.after !== undefined ? { after: input.after } : {}),
            ...(input.before !== undefined ? { before: input.before } : {}),
          },
  });
}

/** Anchor authorization and neighbor authorization use the same predicate. */
export async function readHistory(
  prisma: PrismaClient,
  scope: HistoryScope,
  input: HistoryReadInput,
) {
  const crossThread = input.threadId !== undefined && input.threadId !== scope.threadId;
  const permitted = !crossThread || (scope.allowMyChats === true && !scope.channelId);
  const targetThreadId = input.threadId ?? scope.threadId;
  const authorized = permitted ? visible(scope, crossThread, targetThreadId) : Prisma.sql`FALSE`;
  const limit = Math.min(pageSize(input.limit), 5);
  const direction = input.direction ?? "around";
  if (
    input.textOffset !== undefined &&
    (!Number.isInteger(input.textOffset) || input.textOffset < 0)
  )
    throw new Error("Invalid history text offset");
  if (!["around", "older", "newer"].includes(direction))
    throw new Error("Invalid history direction");
  const anchors = await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns}, t."botId" FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${authorized} AND m.id = ${input.messageId} LIMIT 1
  `);
  const anchor = anchors[0];
  if (!anchor)
    return {
      untrusted: true as const,
      messages: [],
      runs: [],
      snapshots: [],
      nextRunId: null,
      nextArtifactId: null,
      nextOutcomeSeq: null,
      olderMessageId: null,
      newerMessageId: null,
    };
  scope = { ...scope, threadId: targetThreadId, botId: anchor.botId ?? scope.botId };
  const bound =
    direction === "older"
      ? Prisma.sql`m.seq < ${anchor.seq}`
      : direction === "newer"
        ? Prisma.sql`m.seq > ${anchor.seq}`
        : Prisma.sql`m.seq >= ${Math.max(0, anchor.seq - Math.floor(limit / 2))}`;
  const rows =
    input.textOffset !== undefined
      ? [anchor]
      : await prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns} FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${authorized} AND ${bound}
    ORDER BY m.seq ${direction === "older" ? Prisma.sql`DESC` : Prisma.sql`ASC`} LIMIT ${limit}
  `);
  rows.sort((a, b) => a.seq - b.seq);
  const anchoredRunIds = rows.flatMap((row) =>
    row.role === "bot" && row.runId ? [row.runId] : [],
  );
  // Source-less background runs require an authorized surviving output anchor.
  const runRows = await prisma.run.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      threadId: scope.threadId,
      ...(anchor.groupId ? {} : { botId: scope.botId }),
      ...(input.linkedRunId
        ? { id: input.linkedRunId }
        : input.runAfterId
          ? { id: { gt: input.runAfterId } }
          : {}),
      ...(scope.channelId
        ? {
            sourceMessage: {
              threadId: scope.threadId,
              role: "user",
              blocks: {
                array_contains: [{ kind: "channel_message", channelId: scope.channelId }],
              },
            },
          }
        : {
            AND: [
              {
                OR: [
                  { sourceMessage: { threadId: scope.threadId } },
                  { sourceMessageId: null, id: { in: anchoredRunIds } },
                ],
              },
            ],
          }),
      OR: [{ sourceMessageId: { in: rows.map((row) => row.id) } }, { id: { in: anchoredRunIds } }],
    },
    select: {
      id: true,
      sourceMessageId: true,
      status: true,
      createdAt: true,
      completedAt: true,
    },
    orderBy: { id: "asc" },
    take: LINK_PAGE_SIZE + 1,
  });
  const runs = runRows.slice(0, LINK_PAGE_SIZE);
  const [outcomeRows, artifactRows] = await Promise.all([
    runs.length
      ? prisma.$queryRaw<HistoryRow[]>(Prisma.sql`
    SELECT ${columns} FROM messages m JOIN threads t ON t.id = m."threadId"
    WHERE ${authorized} AND m.role = 'bot' AND m."runId" IN (${Prisma.join(runs.map((run) => run.id))})
      ${input.outcomeAfterSeq !== undefined ? Prisma.sql`AND m.seq > ${input.outcomeAfterSeq}` : Prisma.empty}
    ORDER BY m.seq ASC LIMIT ${LINK_PAGE_SIZE + 1}
  `)
      : Promise.resolve([]),
    runs.length
      ? prisma.artifact.findMany({
          where: {
            spaceId: scope.spaceId,
            userId: scope.userId,
            ...(anchor.groupId
              ? { groupId: anchor.groupId }
              : { botId: scope.botId, groupId: null }),
            runId: { in: runs.map((run) => run.id) },
            ...(input.artifactAfterId ? { id: { gt: input.artifactAfterId } } : {}),
          },
          select: {
            id: true,
            runId: true,
            name: true,
            mimeType: true,
            size: true,
          },
          take: LINK_PAGE_SIZE + 1,
          orderBy: { id: "asc" },
        })
      : Promise.resolve([]),
  ]);
  const outcomes = outcomeRows.slice(0, LINK_PAGE_SIZE);
  const artifacts = artifactRows.slice(0, LINK_PAGE_SIZE);
  return bounded({
    untrusted: true as const,
    nextRunId: runRows.length > LINK_PAGE_SIZE ? runs.at(-1)!.id : null,
    nextArtifactId: artifactRows.length > LINK_PAGE_SIZE ? artifacts.at(-1)!.id : null,
    nextOutcomeSeq: outcomeRows.length > LINK_PAGE_SIZE ? outcomes.at(-1)!.seq : null,
    messages: rows.map((row) =>
      reference(row, "", 2000, row.id === anchor.id ? (input.textOffset ?? 0) : 0),
    ),
    runs: runs.map((run) => ({
      ...run,
      outcomes: outcomes.filter((row) => row.runId === run.id).map((row) => reference(row)),
      artifacts: artifacts.filter((artifact) => artifact.runId === run.id),
    })),
    snapshots: rows.map((row) => {
      const linkedRuns = runs.filter(
        (run) => run.sourceMessageId === row.id || run.id === row.runId,
      );
      const outcome = outcomes.find((message) =>
        linkedRuns.some((run) => run.id === message.runId),
      );
      return {
        anchorMessageId: row.id,
        fromSeq: row.seq,
        toSeq: row.seq,
        createdAt: row.createdAt.toISOString(),
        version: createHash("sha256").update(JSON.stringify(row.blocks)).digest("hex"),
        topic: reference(row, "", 200).text,
        openRunIds: linkedRuns
          .filter((run) => !["completed", "failed", "cancelled"].includes(run.status))
          .map((run) => run.id),
        outcome: outcome ? reference(outcome, "", 200).text : null,
        source: "original" as const,
      };
    }),
    olderMessageId: rows[0]?.id ?? null,
    newerMessageId: rows.at(-1)?.id ?? null,
  });
}
