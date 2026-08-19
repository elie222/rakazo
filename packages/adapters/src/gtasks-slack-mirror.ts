import { createHash } from "node:crypto";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import type { ComposioProvider } from "./composio-connector.js";
import { sanitizeComposioError } from "./composio-connector.js";
import {
  acquireSharedConnectionAuthorizationLocks,
  beginConnectionOperation,
  CONNECTION_OPERATION_TRANSACTION_OPTIONS,
  connectionOperationSignal,
} from "./connection-authorization-lock.js";
import {
  createComposioGtasksSlackPort,
  type GtasksSlackPort,
} from "./gtasks-slack-composio-port.js";
import { GTASKS_SLACK_LANE, GTASKS_SLACK_ROUTING } from "./gtasks-slack-config.js";

export type GtaskInboxItem = {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  updated: string;
};

export type GtasksSlackMirrorContext = {
  workspaceId: string;
  userId: string;
};

export type GtasksSlackSyncResult =
  | { status: "ok"; created: number; updated: number; unchanged: number }
  | { status: "skipped"; reason: "connector_unavailable" }
  | { status: "error"; message: string };

type GtaskMirrorContent = Pick<GtaskInboxItem, "id" | "title"> &
  Partial<Pick<GtaskInboxItem, "notes" | "due">>;

export function gtaskMirrorFingerprint(item: GtaskMirrorContent): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: item.title,
        notes: item.notes ?? "",
        due: item.due ?? "",
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

export function gtaskSlackClientMessageId(workspaceId: string, externalId: string): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}:${GTASKS_SLACK_LANE}:${externalId}`)
    .digest("hex")
    .slice(0, 32);
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20)}`;
}

function escapeSlackText(value: string, maxLength: number): string {
  return value
    .slice(0, maxLength)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatGtaskSlackMirror(item: GtaskMirrorContent): string {
  const lines = [`*Google Tasks Inbox:* ${escapeSlackText(item.title, 200)}`];
  if (item.due) lines.push(`Due: ${escapeSlackText(item.due, 64)}`);
  if (item.notes) lines.push(escapeSlackText(item.notes, 400));
  lines.push(`_(source: googletasks:${escapeSlackText(item.id, 100)})_`);
  return lines.join("\n");
}

export async function connectionsReadyForGtasksSlack(
  composio: ComposioProvider | undefined,
  userId: string,
  signal?: AbortSignal,
): Promise<{ googleTasks: boolean; slack: boolean }> {
  if (!composio) return { googleTasks: false, slack: false };
  const [googleTasks, slack] = await Promise.all([
    composio.connectionReady(userId, GTASKS_SLACK_ROUTING.composioProviders.googleTasks, signal),
    composio.connectionReady(userId, GTASKS_SLACK_ROUTING.composioProviders.slack, signal),
  ]);
  return { googleTasks, slack };
}

type MirrorAction = "created" | "updated" | "unchanged" | "scope_unavailable";

async function lockGtasksSlackScope(
  tx: Prisma.TransactionClient,
  ctx: GtasksSlackMirrorContext,
): Promise<boolean> {
  const providers = [
    GTASKS_SLACK_ROUTING.composioProviders.googleTasks,
    GTASKS_SLACK_ROUTING.composioProviders.slack,
  ];
  await acquireSharedConnectionAuthorizationLocks(tx, ctx.userId, providers);
  const members = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "member"
    WHERE "organizationId" = ${ctx.workspaceId} AND "userId" = ${ctx.userId}
    FOR SHARE
  `;
  if (members.length === 0) return false;
  const connections = await tx.$queryRaw<Array<{ provider: string }>>`
    SELECT "provider"
    FROM "connections"
    WHERE "workspaceId" = ${ctx.workspaceId}
      AND "userId" = ${ctx.userId}
      AND "status" = 'connected'
      AND "provider" IN (${providers[0]}, ${providers[1]})
    FOR SHARE
  `;
  const connected = new Set(connections.map((connection) => connection.provider));
  return providers.every((provider) => connected.has(provider));
}

function parseSourceUpdatedAt(updated: unknown): Date {
  const validFormat =
    typeof updated === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(updated);
  const timestamp = typeof updated === "string" ? Date.parse(updated) : Number.NaN;
  if (!validFormat || !Number.isFinite(timestamp)) {
    throw new Error("Google Tasks item is missing a valid updated revision");
  }
  return new Date(timestamp);
}

async function withGtasksSlackScopeLease<T>(
  prisma: PrismaClient,
  ctx: GtasksSlackMirrorContext,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  return prisma.$transaction(async (tx) => {
    const budget = await beginConnectionOperation(tx);
    if (!(await lockGtasksSlackScope(tx, ctx))) return undefined;
    return operation(connectionOperationSignal(budget));
  }, CONNECTION_OPERATION_TRANSACTION_OPTIONS);
}

async function mirrorOneTask(
  deps: {
    prisma: PrismaClient;
    port: GtasksSlackPort;
    events?: ThreadEvents;
    botId?: string;
    threadId?: string;
  },
  ctx: GtasksSlackMirrorContext,
  task: GtaskInboxItem,
): Promise<MirrorAction> {
  const fingerprint = gtaskMirrorFingerprint(task);
  const sourceUpdatedAt = parseSourceUpdatedAt(task.updated);
  const mirror = () =>
    deps.prisma.$transaction(async (tx) => {
      const budget = await beginConnectionOperation(tx);
      const lockKey = `${ctx.workspaceId}:${GTASKS_SLACK_LANE}:${task.id}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

      if (!(await lockGtasksSlackScope(tx, ctx))) return "scope_unavailable" as const;

      const existing = await tx.integrationMirror.findUnique({
        where: {
          workspaceId_lane_externalId: {
            workspaceId: ctx.workspaceId,
            lane: GTASKS_SLACK_LANE,
            externalId: task.id,
          },
        },
      });

      if (existing?.fingerprint === fingerprint) {
        if (!existing.sourceUpdatedAt || sourceUpdatedAt > existing.sourceUpdatedAt) {
          await tx.integrationMirror.update({
            where: { id: existing.id },
            data: { sourceUpdatedAt },
          });
        }
        return "unchanged" as const;
      }

      if (existing?.sourceUpdatedAt && sourceUpdatedAt <= existing.sourceUpdatedAt) {
        return "unchanged" as const;
      }

      const text = formatGtaskSlackMirror(task);
      if (existing?.slackMessageTs) {
        const signal = connectionOperationSignal(budget);
        await deps.port.updateSlackMessage(ctx, existing.slackMessageTs, text, signal);
        await tx.integrationMirror.update({
          where: { id: existing.id },
          data: { fingerprint, sourceUpdatedAt },
        });
        return "updated" as const;
      }

      const signal = connectionOperationSignal(budget);
      const { messageTs } = await deps.port.postSlackMessage(
        ctx,
        text,
        gtaskSlackClientMessageId(ctx.workspaceId, task.id),
        signal,
      );
      await tx.integrationMirror.create({
        data: {
          workspaceId: ctx.workspaceId,
          lane: GTASKS_SLACK_LANE,
          externalId: task.id,
          fingerprint,
          sourceUpdatedAt,
          slackMessageTs: messageTs,
        },
      });
      return "created" as const;
    }, CONNECTION_OPERATION_TRANSACTION_OPTIONS);

  let action: MirrorAction;
  try {
    action = await mirror();
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    action = await mirror();
  }

  if (action === "created" || action === "updated") {
    await emitMirroredEvent(deps, ctx, task.id, action);
  }
  return action;
}

async function emitMirroredEvent(
  deps: {
    events?: ThreadEvents;
    botId?: string;
    threadId?: string;
  },
  ctx: GtasksSlackMirrorContext,
  externalId: string,
  action: "created" | "updated",
): Promise<void> {
  if (!deps.events || !deps.botId || !deps.threadId) return;
  await deps.events.append({
    workspaceId: ctx.workspaceId,
    threadId: deps.threadId,
    botId: deps.botId,
    type: "integration.gtasks_slack.mirrored",
    payload: {
      lane: GTASKS_SLACK_LANE,
      externalId,
      action,
      slackChannelId: GTASKS_SLACK_ROUTING.slackChannelId,
    },
  });
}

async function resolveEventTarget(
  prisma: PrismaClient,
  ctx: GtasksSlackMirrorContext,
): Promise<{ botId: string; threadId: string } | undefined> {
  const bot = await prisma.bot.findFirst({
    where: { workspaceId: ctx.workspaceId, userId: ctx.userId, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    select: { id: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) return undefined;
  return { botId: bot.id, threadId: bot.thread.id };
}

export async function syncGtasksSlackInbox(
  deps: {
    prisma: PrismaClient;
    composio?: ComposioProvider;
    port?: GtasksSlackPort;
    events?: ThreadEvents;
  },
  ctx: GtasksSlackMirrorContext,
): Promise<GtasksSlackSyncResult> {
  const port = deps.port ?? createComposioGtasksSlackPort(deps.composio!);
  let listed: { available: boolean; tasks: GtaskInboxItem[] } | undefined;
  try {
    listed = await withGtasksSlackScopeLease(deps.prisma, ctx, async (signal) => {
      const ready = await connectionsReadyForGtasksSlack(deps.composio, ctx.userId, signal);
      if (!ready.googleTasks || !ready.slack) return { available: false, tasks: [] };
      return { available: true, tasks: await port.listInboxTasks(ctx, signal) };
    });
  } catch (error) {
    return { status: "error", message: sanitizeComposioError(error) };
  }
  if (!listed?.available) {
    return { status: "skipped", reason: "connector_unavailable" };
  }
  const { tasks } = listed;

  const eventTarget = await resolveEventTarget(deps.prisma, ctx);
  const mirrorDeps = {
    prisma: deps.prisma,
    port,
    events: deps.events,
    ...eventTarget,
  };

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const task of tasks) {
    try {
      const action = await mirrorOneTask(mirrorDeps, ctx, task);
      if (action === "scope_unavailable") {
        return { status: "skipped", reason: "connector_unavailable" };
      }
      if (action === "created") created += 1;
      else if (action === "updated") updated += 1;
      else unchanged += 1;
    } catch (error) {
      return { status: "error", message: sanitizeComposioError(error) };
    }
  }

  return { status: "ok", created, updated, unchanged };
}

export async function listGtasksSlackMirrorTargets(
  prisma: PrismaClient,
): Promise<Array<{ workspaceId: string; userId: string }>> {
  const rows = await prisma.connection.findMany({
    where: {
      status: "connected",
      provider: {
        in: [
          GTASKS_SLACK_ROUTING.composioProviders.googleTasks,
          GTASKS_SLACK_ROUTING.composioProviders.slack,
        ],
      },
    },
    select: { workspaceId: true, userId: true, provider: true },
  });

  const byWorkspaceUser = new Map<
    string,
    { workspaceId: string; userId: string; providers: Set<string> }
  >();
  for (const row of rows) {
    const key = `${row.workspaceId}:${row.userId}`;
    const entry = byWorkspaceUser.get(key) ?? {
      workspaceId: row.workspaceId,
      userId: row.userId,
      providers: new Set<string>(),
    };
    entry.providers.add(row.provider);
    byWorkspaceUser.set(key, entry);
  }

  const readyScopes = [...byWorkspaceUser.values()].filter(
    (entry) =>
      entry.providers.has(GTASKS_SLACK_ROUTING.composioProviders.googleTasks) &&
      entry.providers.has(GTASKS_SLACK_ROUTING.composioProviders.slack),
  );

  const byUser = new Map<string, { workspaceId: string; userId: string }>();
  for (const scope of readyScopes) {
    const existing = byUser.get(scope.userId);
    if (!existing || scope.workspaceId < existing.workspaceId) {
      byUser.set(scope.userId, { workspaceId: scope.workspaceId, userId: scope.userId });
    }
  }

  return [...byUser.values()];
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
