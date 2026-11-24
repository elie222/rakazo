import type { UnpricedUsage } from "@rakazo/adapters";
import {
  modelListCost,
  planLimitsReader,
  readMemberPlanLimits,
  resolveBotWorkspacePath,
  USAGE_TOKEN_BUCKETS,
} from "@rakazo/adapters";
import type { ExportManifest, UsageRecord, UsageTotalField } from "@rakazo/contracts";
import { attachmentMaxBytes, MediaModelRoleSchema, resolveBotAvatarSet } from "@rakazo/contracts";
import {
  AttachmentValidationError,
  ClientError,
  validTimezoneOrUtc,
  wallClock,
  zonedDateTime,
} from "@rakazo/core";
import { IsolationError, LISTED_ARTIFACT, Prisma, parseComputerMode } from "@rakazo/db";
import { requireIdentityConfirmation } from "../auth/identity-confirmation.js";
import {
  createOwnedArtifact,
  deleteArtifactFamily,
  getOwnedArtifact,
  getSpaceArtifact,
  getSpaceArtifactById,
  listArtifactVersions,
  listSpaceArtifacts,
} from "../content/artifacts.js";
import { querySpaceSearch } from "../content/search.js";
import { listSpaceRuns } from "../threads/runs.js";
import { loadAllMessages } from "../threads/thread-message-pages.js";
import type { RouterContext } from "./context.js";

const EXPORT_MESSAGE_PAGE_SIZE = 500;

// ICU accepts these legacy names even when PostgreSQL ships only their IANA targets.
const usageTimezoneAliases = new Map([
  ["america/indianapolis", "America/Indiana/Indianapolis"],
  ["asia/calcutta", "Asia/Kolkata"],
  ["asia/rangoon", "Asia/Yangon"],
  ["asia/saigon", "Asia/Ho_Chi_Minh"],
]);

/** The totals summed straight from usage rows; the API cost is priced from them per model. */
const SUMMED_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "costUsd",
] as const satisfies readonly UsageTotalField[];
type SummedField = (typeof SUMMED_FIELDS)[number];

/** A model's API cost: its calls' own costs, plus the calls without one at its list price. */
function withApiCost<
  T extends {
    provider: string;
    model: string;
    costUsd: number | null;
    incomplete: UsageTotalField[];
  },
>(group: T, unpriced: UnpricedUsage | undefined) {
  const listed = !unpriced?.calls
    ? { usd: 0, complete: true }
    : // Calls with no token counts at all leave nothing to price.
      USAGE_TOKEN_BUCKETS.some((bucket) => unpriced.counted[bucket] > 0)
      ? modelListCost(group.provider, group.model, unpriced)
      : null;
  return {
    ...group,
    apiCostUsd: listed === null ? group.costUsd : (group.costUsd ?? 0) + listed.usd,
    apiCostEstimated: (listed?.usd ?? 0) > 0,
    incomplete: listed?.complete ? group.incomplete : [...group.incomplete, "apiCostUsd" as const],
  };
}

/** The models' API costs added up; null only when there are models and none has one. */
function withTotalApiCost<T extends { incomplete: UsageTotalField[] }>(
  totals: T,
  models: readonly {
    apiCostUsd: number | null;
    apiCostEstimated: boolean;
    incomplete: readonly UsageTotalField[];
  }[],
) {
  const known = models.flatMap((model) => (model.apiCostUsd === null ? [] : [model.apiCostUsd]));
  return {
    ...totals,
    apiCostUsd: models.length && !known.length ? null : known.reduce((sum, cost) => sum + cost, 0),
    apiCostEstimated: models.some((model) => model.apiCostEstimated),
    incomplete: models.some((model) => model.incomplete.includes("apiCostUsd"))
      ? [...totals.incomplete, "apiCostUsd" as const]
      : totals.incomplete,
  };
}

/** Images and videos made on a member's own key. They count no tokens, so token totals skip them. */
const MEDIA_OPERATION_KINDS = [...MediaModelRoleSchema.options];
const isMedia = Prisma.sql`u."operationKind" IN (${Prisma.join(MEDIA_OPERATION_KINDS)})`;

export function contentRoutes(ctx: RouterContext) {
  const { deps, repos, favicons, groupRepos, authed, refreshExpiredCredential } = ctx;
  return {
    artifacts: {
      list: authed.artifacts.list.handler(async ({ context, input }) => {
        await repos.getBot(context.actor, input.botId);
        const rows = await deps.prisma.artifact.findMany({
          where: {
            botId: input.botId,
            groupId: null,
            spaceId: context.actor.spaceId,
            ...LISTED_ARTIFACT,
          },
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          groupId: row.groupId,
          runId: row.runId,
          name: row.name,
          description: row.description,
          mimeType: row.mimeType,
          size: row.size,
          version: row.version,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      listSpace: authed.artifacts.listSpace.handler(async ({ context, input }) => {
        if (input.botId) await repos.getBot(context.actor, input.botId);
        return listSpaceArtifacts(deps, context.actor, input);
      }),
      listVersions: authed.artifacts.listVersions.handler(async ({ context, input }) => {
        return listArtifactVersions(deps, context.actor, input);
      }),
      create: authed.artifacts.create.handler(async ({ context, input }) => {
        const botId = input.botId
          ? (await repos.getBot(context.actor, input.botId)).id
          : (await groupRepos.getGroupTarget(context.actor, input.groupId!)).members[0]?.bot.id;
        if (!botId) throw new IsolationError();
        try {
          return await createOwnedArtifact(
            { ...deps, maxUploadSizeBytes: attachmentMaxBytes(deps.env) },
            context.actor,
            { ...input, botId },
          );
        } catch (error) {
          if (error instanceof AttachmentValidationError) {
            throw new ClientError("BAD_REQUEST", error.message);
          }
          throw error;
        }
      }),
      get: authed.artifacts.get.handler(async ({ context, input }) => {
        if (input.groupId) {
          const group = await groupRepos.getGroupTarget(context.actor, input.groupId);
          const contextBotId = group.members[0]?.bot.id;
          if (!contextBotId) throw new IsolationError();
          return getSpaceArtifact(deps, context.actor, {
            artifactId: input.artifactId,
            groupId: input.groupId,
            contextBotId,
          });
        }
        await repos.getBot(context.actor, input.botId!);
        try {
          return await getOwnedArtifact(deps, context.actor, {
            botId: input.botId!,
            artifactId: input.artifactId,
          });
        } catch (error) {
          if (error instanceof IsolationError) throw error;
          throw error;
        }
      }),
      getById: authed.artifacts.getById.handler(async ({ context, input }) => {
        return getSpaceArtifactById(deps, context.actor, input);
      }),
      remove: authed.artifacts.remove.handler(async ({ context, input }) => {
        return deleteArtifactFamily(deps, context.actor, { familyId: input.artifactId });
      }),
    },
    usage: {
      list: authed.usage.list.handler(async ({ context }) => {
        const rows = await deps.prisma.usageRecord.findMany({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            fundingSource: "customer",
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return rows.map((row) => ({
          id: row.id,
          botId: row.botId,
          runId: row.runId,
          provider: row.provider,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          cacheWrite1hTokens: row.cacheWrite1hTokens,
          reasoningTokens: row.reasoningTokens,
          totalTokens: row.totalTokens,
          costUsd: row.costUsd,
          costSource: row.costSource,
          pricingVersion: row.pricingVersion,
          usageSource: row.usageSource,
          callId: row.callId,
          operationId: row.operationId,
          operationKind: row.operationKind as UsageRecord["operationKind"],
          parentRunId: row.parentRunId,
          agentId: row.agentId,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      limits: authed.usage.limits.handler(({ context }) =>
        readMemberPlanLimits(
          deps.prisma,
          deps.secrets,
          context.actor.userId,
          deps.planLimits ?? planLimitsReader,
          (secretId, provider) => refreshExpiredCredential(context.actor, secretId, provider),
        ),
      ),
      summary: authed.usage.summary.handler(async ({ context }) => {
        const where = {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          fundingSource: "customer",
        };
        const sums = {
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          costUsd: true,
        } as const satisfies Record<SummedField, true>;
        const counts = { _all: true, ...sums } as const;
        const [result, modelGroups, unpricedGroups, runGroups, mediaGroups] = await Promise.all([
          deps.prisma.usageRecord.aggregate({ where, _sum: sums, _count: counts }),
          deps.prisma.usageRecord.groupBy({
            by: ["provider", "model"],
            where,
            _sum: sums,
            _count: counts,
          }),
          deps.prisma.usageRecord.groupBy({
            by: ["provider", "model"],
            where: { ...where, costUsd: null },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
            },
            _count: {
              _all: true,
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
            },
          }),
          deps.prisma.usageRecord.groupBy({ by: ["runId", "parentRunId"], where }),
          deps.prisma.usageRecord.groupBy({
            by: ["provider", "model"],
            where: { ...where, operationKind: { in: MEDIA_OPERATION_KINDS } },
            _count: { _all: true },
          }),
        ]);
        const unpriced = new Map(
          unpricedGroups.map((group) => [
            JSON.stringify([group.provider, group.model]),
            {
              calls: group._count._all,
              counted: group._count,
              tokens: {
                inputTokens: group._sum.inputTokens ?? 0,
                outputTokens: group._sum.outputTokens ?? 0,
                cacheReadTokens: group._sum.cacheReadTokens ?? 0,
                cacheWriteTokens: group._sum.cacheWriteTokens ?? 0,
              },
            },
          ]),
        );
        const mediaCalls = (group?: { provider: string; model: string }) =>
          mediaGroups
            .filter(
              (row) => !group || (row.provider === group.provider && row.model === group.model),
            )
            .reduce((total, row) => total + row._count._all, 0);
        const runs = new Set(runGroups.map((row) => row.parentRunId ?? row.runId).filter(Boolean))
          .size;
        // A total that skips rows without a count understates, so it says which ones do. Images and
        // videos count no tokens, so they never make a token total incomplete.
        const knownSums = (
          group: {
            _sum: Record<SummedField, number | null>;
            _count: Record<keyof typeof counts, number>;
          },
          media: number,
        ) => ({
          ...group._sum,
          modelCalls: group._count._all,
          incomplete: SUMMED_FIELDS.filter(
            (field) => group._count[field] + (field === "costUsd" ? 0 : media) < group._count._all,
          ),
        });
        const models = modelGroups
          .map((group) =>
            withApiCost(
              {
                provider: group.provider,
                model: group.model,
                ...knownSums(group, mediaCalls(group)),
              },
              unpriced.get(JSON.stringify([group.provider, group.model])),
            ),
          )
          .sort(
            (a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0) || b.modelCalls - a.modelCalls,
          );
        return { ...withTotalApiCost(knownSums(result, mediaCalls()), models), runs, models };
      }),
      breakdown: authed.usage.breakdown.handler(async ({ context, input }) => {
        const where = {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        } as const;
        const now = new Date();
        const member = await deps.prisma.user.findUnique({
          where: { id: context.actor.userId },
          select: { timezone: true },
        });
        const savedTimezone = member?.timezone ?? "UTC";
        const timezone = validTimezoneOrUtc(
          usageTimezoneAliases.get(savedTimezone.toLowerCase()) ?? savedTimezone,
        );
        const localDay = (at: Date) => wallClock(at, timezone).slice(0, 10);
        const days = input.range === "today" ? 1 : input.range === "7d" ? 7 : 30;
        const firstDate = new Date(`${localDay(now)}T00:00:00Z`);
        firstDate.setUTCDate(firstDate.getUTCDate() - days + 1);
        const since =
          input.range === "all"
            ? null
            : zonedDateTime(firstDate.toISOString().slice(0, 10), timezone)!;
        const rangeFilter = Prisma.sql`
          AND u."createdAt" <= ${now}::timestamp(3)
          ${since ? Prisma.sql`AND u."createdAt" >= ${since}::timestamp(3)` : Prisma.empty}
        `;
        const modelFilter =
          input.provider && input.model
            ? Prisma.sql`AND u.provider = ${input.provider} AND u.model = ${input.model}`
            : input.provider
              ? Prisma.sql`AND u.provider = ${input.provider}`
              : input.model
                ? Prisma.sql`AND u.model = ${input.model}`
                : Prisma.empty;
        const botFilter = input.botId ? Prisma.sql`AND u."botId" = ${input.botId}` : Prisma.empty;

        type TotalsRow = {
          modelCalls: bigint | number;
          runs: bigint | number;
          inputTokens: number | bigint | null;
          inputComplete: boolean;
          outputTokens: number | bigint | null;
          outputComplete: boolean;
          totalTokens: number | bigint | null;
          totalComplete: boolean;
          costUsd: number | null;
          costComplete: boolean;
        };
        type UnpricedRow = {
          provider: string;
          model: string;
          unpricedCalls: bigint | number;
          unpricedInputCounted: bigint | number;
          unpricedOutputCounted: bigint | number;
          unpricedCacheReadCounted: bigint | number;
          unpricedCacheWriteCounted: bigint | number;
          unpricedInput: number;
          unpricedOutput: number;
          unpricedCacheRead: number;
          unpricedCacheWrite: number;
        };
        type ModelRow = TotalsRow &
          UnpricedRow & { cachedTokens: number | bigint | null; cachedComplete: boolean };
        type TimeRow = Omit<TotalsRow, "runs"> & UnpricedRow & { bucket: string };
        type BotRow = TotalsRow & { botId: string; name: string | null; deleted: boolean };

        const toNum = (v: bigint | number | null | undefined) =>
          v == null ? 0 : typeof v === "bigint" ? Number(v) : v;
        const toNullableInt = (v: number | bigint | null) =>
          v == null ? null : Math.round(toNum(v));
        const totalsOf = (row: TotalsRow) => {
          const complete: Record<SummedField, boolean> = {
            inputTokens: row.inputComplete,
            outputTokens: row.outputComplete,
            totalTokens: row.totalComplete,
            costUsd: row.costComplete,
          };
          return {
            runs: "runs" in row ? toNum((row as { runs?: bigint | number }).runs) : 0,
            modelCalls: toNum(row.modelCalls),
            inputTokens: toNullableInt(row.inputTokens),
            outputTokens: toNullableInt(row.outputTokens),
            totalTokens: toNullableInt(row.totalTokens),
            costUsd: row.costUsd,
            incomplete: SUMMED_FIELDS.filter((field) => !complete[field]),
          };
        };

        const unpricedOf = (row: UnpricedRow): UnpricedUsage => ({
          calls: toNum(row.unpricedCalls),
          counted: {
            inputTokens: toNum(row.unpricedInputCounted),
            outputTokens: toNum(row.unpricedOutputCounted),
            cacheReadTokens: toNum(row.unpricedCacheReadCounted),
            cacheWriteTokens: toNum(row.unpricedCacheWriteCounted),
          },
          tokens: {
            inputTokens: row.unpricedInput,
            outputTokens: row.unpricedOutput,
            cacheReadTokens: row.unpricedCacheRead,
            cacheWriteTokens: row.unpricedCacheWrite,
          },
        });
        // A model's calls without a cost of their own, for pricing at its list rates.
        const unpricedSelect = Prisma.sql`
          COUNT(*) FILTER (WHERE u."costUsd" IS NULL)::bigint AS "unpricedCalls",
          COUNT(u."inputTokens") FILTER (WHERE u."costUsd" IS NULL)::bigint AS "unpricedInputCounted",
          COUNT(u."outputTokens") FILTER (WHERE u."costUsd" IS NULL)::bigint AS "unpricedOutputCounted",
          COUNT(u."cacheReadTokens") FILTER (WHERE u."costUsd" IS NULL)::bigint AS "unpricedCacheReadCounted",
          COUNT(u."cacheWriteTokens") FILTER (WHERE u."costUsd" IS NULL)::bigint AS "unpricedCacheWriteCounted",
          COALESCE(SUM(u."inputTokens") FILTER (WHERE u."costUsd" IS NULL), 0)::double precision AS "unpricedInput",
          COALESCE(SUM(u."outputTokens") FILTER (WHERE u."costUsd" IS NULL), 0)::double precision AS "unpricedOutput",
          COALESCE(SUM(u."cacheReadTokens") FILTER (WHERE u."costUsd" IS NULL), 0)::double precision AS "unpricedCacheRead",
          COALESCE(SUM(u."cacheWriteTokens") FILTER (WHERE u."costUsd" IS NULL), 0)::double precision AS "unpricedCacheWrite"
        `;
        const totalsSelect = Prisma.sql`
          COUNT(*)::bigint AS "modelCalls",
          COUNT(DISTINCT COALESCE(u."parentRunId", u."runId")) FILTER (WHERE COALESCE(u."parentRunId", u."runId") IS NOT NULL)::bigint AS runs,
          SUM(u."inputTokens")::double precision AS "inputTokens",
          BOOL_AND(u."inputTokens" IS NOT NULL OR ${isMedia}) AS "inputComplete",
          SUM(u."outputTokens")::double precision AS "outputTokens",
          BOOL_AND(u."outputTokens" IS NOT NULL OR ${isMedia}) AS "outputComplete",
          SUM(u."totalTokens")::double precision AS "totalTokens",
          BOOL_AND(u."totalTokens" IS NOT NULL OR ${isMedia}) AS "totalComplete",
          SUM(u."costUsd")::double precision AS "costUsd",
          BOOL_AND(u."costUsd" IS NOT NULL) AS "costComplete"
        `;

        const [totalsRows, modelRows, timeRows, botRows, modelOptionRows] =
          await deps.prisma.$transaction(
            (tx) =>
              Promise.all([
                tx.$queryRaw<TotalsRow[]>(Prisma.sql`
            SELECT ${totalsSelect}
            FROM usage_records u
            WHERE u."spaceId" = ${where.spaceId} AND u."userId" = ${where.userId} AND u."fundingSource" = 'customer'
              ${rangeFilter} ${modelFilter} ${botFilter}
          `),
                // Rows from before cache reads were measured hold a zero and no total, so a zero
                // counts as measured only where the row's total is; any other count was measured.
                tx.$queryRaw<ModelRow[]>(Prisma.sql`
            SELECT u.provider, u.model, ${totalsSelect}, ${unpricedSelect},
              SUM(u."cacheReadTokens")::double precision AS "cachedTokens",
              BOOL_AND(COALESCE(u."cacheReadTokens" > 0 OR (u."cacheReadTokens" = 0 AND u."totalTokens" IS NOT NULL), false) OR ${isMedia}) AS "cachedComplete"
            FROM usage_records u
            WHERE u."spaceId" = ${where.spaceId} AND u."userId" = ${where.userId} AND u."fundingSource" = 'customer'
              ${rangeFilter} ${modelFilter} ${botFilter}
            GROUP BY u.provider, u.model
            ORDER BY COALESCE(SUM(u."totalTokens"), 0) DESC, COUNT(*) DESC
          `),
                tx.$queryRaw<TimeRow[]>(Prisma.sql`
            SELECT to_char(u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS bucket,
              u.provider, u.model, ${unpricedSelect},
              COUNT(*)::bigint AS "modelCalls",
              SUM(u."inputTokens")::double precision AS "inputTokens",
              BOOL_AND(u."inputTokens" IS NOT NULL OR ${isMedia}) AS "inputComplete",
              SUM(u."outputTokens")::double precision AS "outputTokens",
              BOOL_AND(u."outputTokens" IS NOT NULL OR ${isMedia}) AS "outputComplete",
              SUM(u."totalTokens")::double precision AS "totalTokens",
              BOOL_AND(u."totalTokens" IS NOT NULL OR ${isMedia}) AS "totalComplete",
              SUM(u."costUsd")::double precision AS "costUsd",
              BOOL_AND(u."costUsd" IS NOT NULL) AS "costComplete"
            FROM usage_records u
            WHERE u."spaceId" = ${where.spaceId} AND u."userId" = ${where.userId} AND u."fundingSource" = 'customer'
              ${rangeFilter} ${modelFilter} ${botFilter}
            GROUP BY bucket, u.provider, u.model
            ORDER BY bucket ASC
          `),
                // The selectors list everything used in the range, so any bot/model pair stays selectable.
                tx.$queryRaw<BotRow[]>(Prisma.sql`
            SELECT u."botId" AS "botId",
              COALESCE(b.name, bd.name) AS name,
              (b.id IS NULL) AS deleted,
              ${totalsSelect}
            FROM usage_records u
            LEFT JOIN bots b ON b.id = u."botId"
            LEFT JOIN bot_deletions bd ON bd.id = u."botId"
            WHERE u."spaceId" = ${where.spaceId} AND u."userId" = ${where.userId} AND u."fundingSource" = 'customer'
              AND u."botId" IS NOT NULL
              ${rangeFilter}
            GROUP BY u."botId", b.id, b.name, bd.name
            ORDER BY COALESCE(SUM(u."totalTokens"), 0) DESC, COUNT(*) DESC
          `),
                tx.$queryRaw<{ provider: string; model: string }[]>(Prisma.sql`
            SELECT u.provider, u.model
            FROM usage_records u
            WHERE u."spaceId" = ${where.spaceId} AND u."userId" = ${where.userId} AND u."fundingSource" = 'customer'
              ${rangeFilter}
            GROUP BY u.provider, u.model
            ORDER BY COALESCE(SUM(u."totalTokens"), 0) DESC, COUNT(*) DESC
          `),
              ]),
            { isolationLevel: "RepeatableRead" },
          );

        const rawTotals =
          totalsRows[0] ??
          ({
            modelCalls: 0,
            runs: 0,
            inputTokens: null,
            inputComplete: true,
            outputTokens: null,
            outputComplete: true,
            totalTokens: null,
            totalComplete: true,
            costUsd: null,
            costComplete: true,
          } satisfies TotalsRow);
        const totals = (() => {
          if (toNum(rawTotals.modelCalls) === 0) {
            return {
              runs: 0,
              modelCalls: 0,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              incomplete: [],
            };
          }
          return totalsOf(rawTotals);
        })();

        const nextDay = (day: string) =>
          new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        type Point = {
          modelCalls: number;
          inputTokens: number | null;
          outputTokens: number | null;
          totalTokens: number | null;
          costUsd: number | null;
          apiCostUsd: number | null;
          apiCostEstimated: boolean;
          incomplete: UsageTotalField[];
        };
        const add = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : a + b);
        const merge = (a: Point, b: Point): Point => ({
          modelCalls: a.modelCalls + b.modelCalls,
          inputTokens: add(a.inputTokens, b.inputTokens),
          outputTokens: add(a.outputTokens, b.outputTokens),
          totalTokens: add(a.totalTokens, b.totalTokens),
          costUsd: add(a.costUsd, b.costUsd),
          apiCostUsd: add(a.apiCostUsd, b.apiCostUsd),
          apiCostEstimated: a.apiCostEstimated || b.apiCostEstimated,
          incomplete: [...new Set([...a.incomplete, ...b.incomplete])],
        });
        // Each day arrives split by model, since list prices are per model.
        const points = new Map<string, Point>();
        for (const row of timeRows) {
          const { runs: _runs, ...t } = totalsOf({ ...row, runs: 0 });
          const {
            provider: _provider,
            model: _model,
            ...point
          } = withApiCost({ provider: row.provider, model: row.model, ...t }, unpricedOf(row));
          const previous = points.get(row.bucket);
          points.set(row.bucket, previous ? merge(previous, point) : point);
        }
        const firstDay = since ? localDay(since) : timeRows[0]?.bucket;
        const lastDay = localDay(now);
        const overTimeUnit =
          input.range === "all" &&
          firstDay &&
          Date.parse(lastDay) - Date.parse(firstDay) > 60 * 86_400_000
            ? "month"
            : "day";
        const empty: Point = {
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          apiCostUsd: 0,
          apiCostEstimated: false,
          incomplete: [],
        };
        const overTime: ({ date: string } & Point)[] = [];
        // Every day or month in the range gets a point, so quiet stretches show as gaps.
        for (
          let day = timeRows.length > 0 ? firstDay : undefined;
          day && day <= lastDay;
          day = nextDay(day)
        ) {
          const date = overTimeUnit === "month" ? `${day.slice(0, 7)}-01` : day;
          const point = points.get(day);
          const last = overTime.at(-1);
          if (last?.date !== date) {
            overTime.push({ date, ...(point ?? empty) });
            continue;
          }
          // A quiet day adds nothing, so a month whose calls lack a figure still reads unknown.
          if (!point) continue;
          overTime[overTime.length - 1] = {
            date,
            ...(last.modelCalls === 0 ? point : merge(last, point)),
          };
        }

        const models = modelRows.map((row) => {
          const { runs: _runs, ...t } = totalsOf({ ...row, runs: 0 });
          return withApiCost(
            {
              provider: row.provider,
              model: row.model,
              ...t,
              cachedTokens: row.cachedComplete ? toNullableInt(row.cachedTokens) : null,
            },
            unpricedOf(row),
          );
        });

        return {
          range: input.range,
          totals: withTotalApiCost(totals, models),
          modelOptions: modelOptionRows.map(({ provider, model }) => ({ provider, model })),
          models,
          overTimeUnit,
          overTime,
          bots: botRows.map((row) => ({
            id: row.botId,
            name: row.name,
            deleted: row.deleted,
            ...totalsOf(row),
          })),
        };
      }),
    },
    export: {
      bot: authed.export.bot.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.thread || !bot.computer) throw new IsolationError();
        const homeKey = bot.computer.homeKey;
        const computerMode = parseComputerMode(bot.computer.scope);
        const exportContext = {
          operationId: "export",
          traceId: "export",
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          signal: new AbortController().signal,
        };
        const [memory, routines, files, history] = await Promise.all([
          deps.prisma.memoryDocument.findMany({
            where: { botId: input.botId, spaceId: context.actor.spaceId },
          }),
          deps.prisma.routine.findMany({
            where: { botId: input.botId, spaceId: context.actor.spaceId },
          }),
          (async () => {
            const exported: ExportManifest["files"] = [];
            const directory = resolveBotWorkspacePath(computerMode, bot.id, "");
            // Root dotfiles contain computer state rather than portable bot files.
            for await (const file of deps.home.exportHome(homeKey, exportContext, {
              directory,
              skipHidden: true,
            })) {
              exported.push(exportFile(file.path, file.content));
            }
            return exported;
          })(),
          loadAllMessages(deps.prisma, bot.thread.id, EXPORT_MESSAGE_PAGE_SIZE),
        ]);
        return {
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          bot: {
            name: bot.name,
            description: bot.description,
            instructions: bot.instructions,
            color: bot.color,
            avatarSet: resolveBotAvatarSet(bot.avatarSet),
          },
          memory: memory.map((m) => ({ path: m.path, content: m.content })),
          routines: routines.map((r) => ({
            name: r.name,
            prompt: r.prompt,
            crons: r.crons,
            timezone: r.timezone,
          })),
          files,
          history,
        };
      }),
      accountToken: authed.export.accountToken.handler(async ({ context }) => {
        await requireIdentityConfirmation(deps.auth, context);
        return { token: await deps.auth.issueAccountExportToken(context.actor.userId) };
      }),
    },
    search: {
      query: authed.search.query.handler(async ({ context, input }) => ({
        hits: await querySpaceSearch(deps.prisma, context.actor, input.q, context.signal),
      })),
    },
    links: {
      favicon: authed.links.favicon.handler(async ({ input }) => favicons.favicon(input.origin)),
    },
    runs: {
      list: authed.runs.list.handler(async ({ context, input }) => ({
        runs: await listSpaceRuns(deps.prisma, context.actor, input.filter, input.status),
      })),
    },
  };
}

/** Valid UTF-8 stays readable text; anything else is base64 so the bytes survive the JSON. */
function exportFile(path: string, content: Uint8Array): ExportManifest["files"][number] {
  try {
    return {
      path,
      content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content),
    };
  } catch {
    return { path, content: Buffer.from(content).toString("base64"), encoding: "base64" };
  }
}
