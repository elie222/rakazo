import type { Actor, UsageBreakdown, UsageBreakdownInput } from "@rakazo/contracts";
import { MediaModelRoleSchema } from "@rakazo/contracts";
import { validTimezoneOrUtc, wallClock, zonedDateTime } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

/** Images and videos made on a member's own key. They count no tokens, so token totals skip them. */
export const MEDIA_OPERATION_KINDS = [...MediaModelRoleSchema.options];
const DAY_MS = 86_400_000;
const isMedia = Prisma.sql`u."operationKind" IN (${Prisma.join(MEDIA_OPERATION_KINDS)})`;

type Measures = {
  modelCalls: number | null;
  inputTokens: number | null;
  inputComplete: boolean | null;
  outputTokens: number | null;
  outputComplete: boolean | null;
  totalTokens: number | null;
  totalComplete: boolean | null;
  costUsd: number | null;
  costComplete: boolean | null;
};
type Totals = Measures & { runs: number };
type BreakdownRow = {
  totals: Totals;
  models: (Totals & {
    provider: string;
    model: string;
    cachedTokens: number | null;
    cachedComplete: boolean | null;
  })[];
  days: (Measures & { day: number })[];
  bots: (Totals & { botId: string; name: string | null; deleted: boolean })[];
  modelOptions: { provider: string; model: string }[];
  routines: (Totals & { routineId: string | null; name: string | null; botName: string | null })[];
};

const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

const complete = (value: number | null, measured: boolean | null) =>
  measured ? (value ?? 0) : null;
const totalsOf = (row: Measures) => ({
  modelCalls: row.modelCalls ?? 0,
  inputTokens: complete(row.inputTokens, row.inputComplete),
  outputTokens: complete(row.outputTokens, row.outputComplete),
  totalTokens: complete(row.totalTokens, row.totalComplete),
  costUsd: complete(row.costUsd, row.costComplete),
});

/**
 * Days are cut in JavaScript and handed to the query as instants, so the database never needs
 * to know the member's timezone, whose name it may not recognise.
 */
export async function readUsageBreakdown(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: UsageBreakdownInput,
): Promise<UsageBreakdown> {
  const { spaceId, userId } = actor;
  const now = new Date();
  const member = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = validTimezoneOrUtc(member?.timezone ?? "UTC");
  const localDay = (at: Date) => wallClock(at, timezone).slice(0, 10);
  const lastDay = localDay(now);

  const owned = Prisma.sql`u."spaceId" = ${spaceId} AND u."userId" = ${userId} AND u."fundingSource" = 'customer'`;
  const selection = Prisma.sql`
    ${input.provider ? Prisma.sql`AND u.provider = ${input.provider}` : Prisma.empty}
    ${input.model ? Prisma.sql`AND u.model = ${input.model}` : Prisma.empty}
    ${input.botId ? Prisma.sql`AND u."botId" = ${input.botId}` : Prisma.empty}
  `;

  let firstDay = lastDay;
  if (input.range === "all") {
    const [first] = await prisma.$queryRaw<{ at: Date | null }[]>(Prisma.sql`
      SELECT MIN(u."createdAt") AS at FROM usage_records u
      WHERE ${owned} AND u."createdAt" <= ${now}::timestamp(3) ${selection}
    `);
    if (first?.at) firstDay = localDay(first.at);
  } else {
    const days = input.range === "today" ? 1 : input.range === "7d" ? 7 : 30;
    firstDay = new Date(Date.parse(`${lastDay}T00:00:00Z`) - (days - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
  }
  const days: string[] = [];
  for (let day = firstDay; day <= lastDay; day = nextDay(day)) days.push(day);
  const dayStarts = days.map((day) => zonedDateTime(day, timezone)!.toISOString());
  const since =
    input.range === "all"
      ? Prisma.empty
      : Prisma.sql`AND u."createdAt" >= ${dayStarts[0]}::timestamp(3)`;

  const runs = Prisma.sql`COUNT(DISTINCT u."runId")::int AS runs`;
  const measures = Prisma.sql`
    SUM(u."modelCalls")::double precision AS "modelCalls",
    SUM(u."inputTokens") AS "inputTokens",
    BOOL_AND(u."inputComplete") AS "inputComplete",
    SUM(u."outputTokens") AS "outputTokens",
    BOOL_AND(u."outputComplete") AS "outputComplete",
    SUM(u."totalTokens") AS "totalTokens",
    BOOL_AND(u."totalComplete") AS "totalComplete",
    SUM(u."costUsd") AS "costUsd",
    BOOL_AND(u."costComplete") AS "costComplete"
  `;
  const largestFirst = Prisma.sql`COALESCE(t."totalTokens", 0) DESC, t."modelCalls" DESC`;

  // One statement reads one snapshot, and its single pass over the member's calls folds them
  // into one row per run, day, model and bot before every section sums those.
  const [row] = await prisma.$queryRaw<BreakdownRow[]>(Prisma.sql`
    WITH RECURSIVE calls AS (
      SELECT COALESCE(u."parentRunId", u."runId") AS "runId",
        width_bucket(u."createdAt", ${dayStarts}::timestamp(3)[]) AS day,
        u.provider, u.model, u."botId",
        COUNT(*) AS "modelCalls",
        SUM(u."inputTokens")::double precision AS "inputTokens",
        BOOL_AND(u."inputTokens" IS NOT NULL OR ${isMedia}) AS "inputComplete",
        SUM(u."outputTokens")::double precision AS "outputTokens",
        BOOL_AND(u."outputTokens" IS NOT NULL OR ${isMedia}) AS "outputComplete",
        SUM(u."totalTokens")::double precision AS "totalTokens",
        BOOL_AND(u."totalTokens" IS NOT NULL OR ${isMedia}) AS "totalComplete",
        SUM(u."costUsd")::double precision AS "costUsd",
        BOOL_AND(u."costUsd" IS NOT NULL) AS "costComplete",
        SUM(u."cacheReadTokens")::double precision AS "cachedTokens",
        -- Rows from before cache reads were measured hold a zero and no total, so a zero counts
        -- as measured only where the row's total is; any other count was measured.
        BOOL_AND(COALESCE(u."cacheReadTokens" > 0 OR (u."cacheReadTokens" = 0 AND u."totalTokens" IS NOT NULL), false) OR ${isMedia}) AS "cachedComplete"
      FROM usage_records u
      WHERE ${owned} AND u."createdAt" <= ${now}::timestamp(3) ${since}
      GROUP BY 1, 2, 3, 4, 5
    ), selected AS (
      SELECT * FROM calls u WHERE true ${selection}
    ), by_run AS (
      SELECT u."runId", ${measures} FROM selected u GROUP BY 1
    ), chain AS (
      SELECT u."runId", r."routineId", r."delegatedFromRunId", 0 AS depth
      FROM by_run u
      JOIN runs r ON r.id = u."runId" AND r."spaceId" = ${spaceId} AND r."userId" = ${userId}
      UNION ALL
      SELECT chain."runId", r."routineId", r."delegatedFromRunId", chain.depth + 1
      FROM chain
      JOIN runs r ON r.id = chain."delegatedFromRunId" AND r."spaceId" = ${spaceId} AND r."userId" = ${userId}
      WHERE chain."routineId" IS NULL AND chain.depth < 16
    )
    SELECT
      (SELECT row_to_json(t) FROM (SELECT ${runs}, ${measures} FROM selected u) t) AS totals,
      (SELECT COALESCE(json_agg(t ORDER BY ${largestFirst}), '[]') FROM (
        SELECT u.provider, u.model, ${runs}, ${measures},
          SUM(u."cachedTokens") AS "cachedTokens", BOOL_AND(u."cachedComplete") AS "cachedComplete"
        FROM selected u GROUP BY u.provider, u.model
      ) t) AS models,
      (SELECT COALESCE(json_agg(t), '[]') FROM (
        SELECT u.day, ${measures} FROM selected u GROUP BY u.day
      ) t) AS days,
      -- The selectors list everything used in the range, so any bot/model pair stays selectable.
      (SELECT COALESCE(json_agg(t ORDER BY ${largestFirst}), '[]') FROM (
        SELECT u."botId", COALESCE(b.name, bd.name) AS name, (b.id IS NULL) AS deleted, ${runs}, ${measures}
        FROM calls u
        LEFT JOIN bots b ON b.id = u."botId"
        LEFT JOIN bot_deletions bd ON bd.id = u."botId"
        WHERE u."botId" IS NOT NULL
        GROUP BY u."botId", b.id, b.name, bd.name
      ) t) AS bots,
      (SELECT COALESCE(json_agg(json_build_object('provider', t.provider, 'model', t.model) ORDER BY ${largestFirst}), '[]') FROM (
        SELECT u.provider, u.model, SUM(u."totalTokens") AS "totalTokens", SUM(u."modelCalls") AS "modelCalls"
        FROM calls u GROUP BY u.provider, u.model
      ) t) AS "modelOptions",
      (SELECT COALESCE(json_agg(t ORDER BY t."routineId" IS NULL, ${largestFirst}, t."routineId"), '[]') FROM (
        SELECT ro.id AS "routineId", ro.name, b.name AS "botName", COUNT(u."runId")::int AS runs, ${measures}
        FROM by_run u
        LEFT JOIN chain c ON c."runId" = u."runId" AND c."routineId" IS NOT NULL
        LEFT JOIN routines ro ON ro.id = c."routineId" AND ro."spaceId" = ${spaceId}
        LEFT JOIN bots b ON b.id = ro."botId" AND b."spaceId" = ${spaceId}
        GROUP BY ro.id, ro.name, b.name
      ) t) AS routines
  `);
  if (!row) throw new Error("usage breakdown returned no row");

  const totals = (() => {
    const raw = row.totals;
    if (!raw.modelCalls) {
      return {
        runs: 0,
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      };
    }
    // A few calls without a count (an interrupted one) must not blank the whole total.
    const tokensPartial = !raw.totalComplete && raw.totalTokens !== null;
    return {
      runs: raw.runs,
      ...totalsOf({ ...raw, totalComplete: raw.totalComplete || tokensPartial }),
      tokensPartial,
    };
  })();

  type Point = ReturnType<typeof totalsOf>;
  const points = new Map(row.days.map((point) => [days[point.day - 1], totalsOf(point)]));
  const overTimeUnit =
    input.range === "all" && Date.parse(lastDay) - Date.parse(firstDay) > 60 * DAY_MS
      ? "month"
      : "day";
  const empty: Point = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  const add = (a: number | null, b: number | null) => (a == null || b == null ? null : a + b);
  const overTime: ({ date: string } & Point)[] = [];
  // Every day or month in the range gets a point, so quiet stretches show as gaps.
  for (const day of row.days.length > 0 ? days : []) {
    const date = overTimeUnit === "month" ? `${day.slice(0, 7)}-01` : day;
    const point = points.get(day) ?? empty;
    const last = overTime.at(-1);
    if (last?.date !== date) {
      overTime.push({ date, ...point });
      continue;
    }
    last.modelCalls += point.modelCalls;
    last.inputTokens = add(last.inputTokens, point.inputTokens);
    last.outputTokens = add(last.outputTokens, point.outputTokens);
    last.totalTokens = add(last.totalTokens, point.totalTokens);
    last.costUsd = add(last.costUsd, point.costUsd);
  }

  return {
    range: input.range,
    totals,
    modelOptions: row.modelOptions,
    models: row.models.map((model) => ({
      provider: model.provider,
      model: model.model,
      ...totalsOf(model),
      cachedTokens: complete(model.cachedTokens, model.cachedComplete),
    })),
    routines: row.routines.map((routine) => ({
      id: routine.routineId,
      name: routine.name,
      botName: routine.botName,
      runs: routine.runs,
      ...totalsOf(routine),
    })),
    overTimeUnit,
    overTime,
    bots: row.bots.map((bot) => ({
      id: bot.botId,
      name: bot.name,
      deleted: bot.deleted,
      runs: bot.runs,
      ...totalsOf(bot),
    })),
  };
}
