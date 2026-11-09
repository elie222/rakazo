import { ORPCError } from "@orpc/server";
import type { UsageOperationKind } from "@rakazo/adapter-kit";
import { resolveBotWorkspacePath } from "@rakazo/adapters";
import type { ExportManifest } from "@rakazo/contracts";
import { attachmentMaxBytes, resolveBotAvatarSet } from "@rakazo/contracts";
import { AttachmentValidationError } from "@rakazo/core";
import { IsolationError, LISTED_ARTIFACT, parseComputerMode } from "@rakazo/db";
import {
  ArtifactListCursorError,
  createOwnedArtifact,
  deleteArtifactFamily,
  getOwnedArtifact,
  getSpaceArtifact,
  getSpaceArtifactById,
  listArtifactVersions,
  listSpaceArtifacts,
} from "../artifacts.js";
import { requireIdentityConfirmation } from "../identity-confirmation.js";
import { listSpaceRuns } from "../runs.js";
import { querySpaceSearch } from "../search.js";
import { loadAllMessages } from "../thread-message-pages.js";
import type { UsageRowLike, UsageSumCount } from "../usage-summary.js";
import { usageTotals, usageTotalsFromRows } from "../usage-summary.js";
import type { RouterContext } from "./context.js";

const EXPORT_MESSAGE_PAGE_SIZE = 500;

export function contentRoutes(ctx: RouterContext) {
  const { deps, repos, favicons, groupRepos, authed } = ctx;
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
        try {
          return await listSpaceArtifacts(deps, context.actor, input);
        } catch (error) {
          if (error instanceof ArtifactListCursorError) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
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
            throw new ORPCError("BAD_REQUEST", { message: error.message });
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
          where: { spaceId: context.actor.spaceId, userId: context.actor.userId },
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
          failureReason: row.failureReason,
          audioSeconds: row.audioSeconds,
          audioBytes: row.audioBytes,
          transcribedChars: row.transcribedChars,
          callId: row.callId,
          operationId: row.operationId,
          operationKind: row.operationKind as UsageOperationKind,
          parentRunId: row.parentRunId,
          agentId: row.agentId,
          createdAt: row.createdAt.toISOString(),
        }));
      }),
      summary: authed.usage.summary.handler(async ({ context, input }) => {
        const since =
          input?.days !== undefined
            ? new Date(Date.now() - input.days * 24 * 60 * 60 * 1000)
            : undefined;
        const where = {
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          ...(since ? { createdAt: { gte: since } } : {}),
        };
        const sums = {
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          costUsd: true,
        } as const;
        const counts = { _all: true, ...sums } as const;
        // The counted aggregates exclude transcription calls, which have no
        // tokens by design; they feed only the unknown-usage counts.
        const countedWhere = { ...where, operationKind: { not: "transcription" } };
        const [
          result,
          countedResult,
          modelGroups,
          countedModelGroups,
          botGroups,
          countedBotGroups,
          runGroups,
          dayRows,
        ] = await Promise.all([
          deps.prisma.usageRecord.aggregate({ where, _sum: sums, _count: counts }),
          deps.prisma.usageRecord.aggregate({ where: countedWhere, _sum: sums, _count: counts }),
          deps.prisma.usageRecord.groupBy({
            by: ["provider", "model"],
            where,
            _sum: sums,
            _count: counts,
          }),
          deps.prisma.usageRecord.groupBy({
            by: ["provider", "model"],
            where: countedWhere,
            _sum: sums,
            _count: counts,
          }),
          deps.prisma.usageRecord.groupBy({
            by: ["botId"],
            where,
            _sum: sums,
            _count: counts,
          }),
          deps.prisma.usageRecord.groupBy({
            by: ["botId"],
            where: countedWhere,
            _sum: sums,
            _count: counts,
          }),
          deps.prisma.usageRecord.groupBy({ by: ["runId", "parentRunId"], where }),
          // Daily series for the heatmap, capped at a year.
          deps.prisma.usageRecord.findMany({
            where: {
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              createdAt: { gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
            },
            select: {
              createdAt: true,
              inputTokens: true,
              outputTokens: true,
              totalTokens: true,
              costUsd: true,
              operationKind: true,
            },
            orderBy: { createdAt: "asc" },
          }),
        ]);
        const runs = new Set(runGroups.map((row) => row.parentRunId ?? row.runId).filter(Boolean))
          .size;
        // A group with only transcription calls has no counted aggregate; its
        // unknown counts are zero, not missing.
        const emptyCounted: UsageSumCount = {
          _sum: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
          _count: { _all: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        };
        const countedModelByKey = new Map(
          countedModelGroups.map((group) => [JSON.stringify([group.provider, group.model]), group]),
        );
        const countedBotByKey = new Map(
          countedBotGroups.map((group) => [group.botId ?? "", group]),
        );
        const botIds = botGroups.map((group) => group.botId).filter(Boolean) as string[];
        const bots = botIds.length
          ? await deps.prisma.bot.findMany({
              where: { id: { in: botIds }, spaceId: context.actor.spaceId },
              select: { id: true, name: true },
            })
          : [];
        const botNameById = new Map(bots.map((bot) => [bot.id, bot.name]));
        const byDay = new Map<string, UsageRowLike[]>();
        for (const row of dayRows) {
          const date = row.createdAt.toISOString().slice(0, 10);
          const rows = byDay.get(date) ?? [];
          rows.push(row);
          byDay.set(date, rows);
        }
        const daily = [...byDay.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, rows]) => ({ date, ...usageTotalsFromRows(rows) }));
        return {
          ...usageTotals(result, countedResult),
          runs,
          models: modelGroups
            .map((group) => ({
              provider: group.provider,
              model: group.model,
              ...usageTotals(
                group,
                countedModelByKey.get(JSON.stringify([group.provider, group.model])) ??
                  emptyCounted,
              ),
            }))
            .sort(
              (a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0) || b.modelCalls - a.modelCalls,
            ),
          bots: botGroups
            .map((group) => ({
              botId: group.botId ?? "",
              botName: group.botId ? (botNameById.get(group.botId) ?? null) : null,
              ...usageTotals(group, countedBotByKey.get(group.botId ?? "") ?? emptyCounted),
            }))
            .sort(
              (a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0) || b.modelCalls - a.modelCalls,
            ),
          daily,
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
        hits: await querySpaceSearch(deps.prisma, context.actor, input.q),
      })),
    },
    links: {
      favicon: authed.links.favicon.handler(async ({ input }) => favicons.favicon(input.origin)),
    },
    runs: {
      list: authed.runs.list.handler(async ({ context, input }) => ({
        runs: await listSpaceRuns(deps.prisma, context.actor, input.filter),
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
