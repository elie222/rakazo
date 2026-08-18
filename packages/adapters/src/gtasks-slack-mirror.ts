import { createHash } from "node:crypto";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import type { ComposioProvider } from "./composio-connector.js";
import { sanitizeComposioError } from "./composio-connector.js";
import { GTASKS_SLACK_LANE, GTASKS_SLACK_ROUTING } from "./gtasks-slack-config.js";
import {
  createComposioGtasksSlackPort,
  type GtasksSlackPort,
} from "./gtasks-slack-composio-port.js";

export type GtaskInboxItem = {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  updated?: string;
};

export type GtasksSlackMirrorContext = {
  workspaceId: string;
  userId: string;
};

export type GtasksSlackSyncResult =
  | { status: "ok"; created: number; updated: number; unchanged: number }
  | { status: "skipped"; reason: "connector_unavailable" }
  | { status: "error"; message: string };

export function gtaskMirrorFingerprint(item: GtaskInboxItem): string {
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

export function formatGtaskSlackMirror(item: GtaskInboxItem): string {
  const lines = [`*Google Tasks Inbox:* ${item.title}`];
  if (item.due) lines.push(`Due: ${item.due}`);
  if (item.notes) lines.push(item.notes.slice(0, 500));
  lines.push(`_(source: googletasks:${item.id})_`);
  return lines.join("\n");
}

export async function connectionsReadyForGtasksSlack(
  composio: ComposioProvider | undefined,
  userId: string,
): Promise<{ googleTasks: boolean; slack: boolean }> {
  if (!composio) return { googleTasks: false, slack: false };
  const [googleTasks, slack] = await Promise.all([
    composio.connectionReady(userId, GTASKS_SLACK_ROUTING.composioProviders.googleTasks),
    composio.connectionReady(userId, GTASKS_SLACK_ROUTING.composioProviders.slack),
  ]);
  return { googleTasks, slack };
}

type MirrorAction = "created" | "updated" | "unchanged" | "scope_unavailable";

async function gtasksSlackScopeReady(
  prisma: PrismaClient | Prisma.TransactionClient,
  ctx: GtasksSlackMirrorContext,
): Promise<boolean> {
  const providers = [
    GTASKS_SLACK_ROUTING.composioProviders.googleTasks,
    GTASKS_SLACK_ROUTING.composioProviders.slack,
  ];
  const [member, connections] = await Promise.all([
    prisma.member.findFirst({
      where: { organizationId: ctx.workspaceId, userId: ctx.userId },
      select: { id: true },
    }),
    prisma.connection.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        status: "connected",
        provider: { in: providers },
      },
      select: { provider: true },
    }),
  ]);
  if (!member) return false;
  const connected = new Set(connections.map((connection) => connection.provider));
  return providers.every((provider) => connected.has(provider));
}

function parseSourceUpdatedAt(updated: string | undefined): Date | null {
  if (!updated) return null;
  const timestamp = Date.parse(updated);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
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
    deps.prisma.$transaction(
      async (tx) => {
        const lockKey = `${ctx.workspaceId}:${GTASKS_SLACK_LANE}:${task.id}`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

        if (!(await gtasksSlackScopeReady(tx, ctx))) return "scope_unavailable" as const;

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
          if (
            sourceUpdatedAt &&
            (!existing.sourceUpdatedAt || sourceUpdatedAt > existing.sourceUpdatedAt)
          ) {
            await tx.integrationMirror.update({
              where: { id: existing.id },
              data: { sourceUpdatedAt },
            });
          }
          return "unchanged" as const;
        }

        if (
          existing?.sourceUpdatedAt &&
          (!sourceUpdatedAt || sourceUpdatedAt <= existing.sourceUpdatedAt)
        ) {
          return "unchanged" as const;
        }

        const text = formatGtaskSlackMirror(task);
        if (existing?.slackMessageTs) {
          await deps.port.updateSlackMessage(ctx, existing.slackMessageTs, text);
          await tx.integrationMirror.update({
            where: { id: existing.id },
            data: { fingerprint, sourceUpdatedAt },
          });
          return "updated" as const;
        }

        const { messageTs } = await deps.port.postSlackMessage(ctx, text);
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
      },
      { maxWait: 70_000, timeout: 70_000 },
    );

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
  if (!(await gtasksSlackScopeReady(deps.prisma, ctx))) {
    return { status: "skipped", reason: "connector_unavailable" };
  }

  const ready = await connectionsReadyForGtasksSlack(deps.composio, ctx.userId);
  if (!ready.googleTasks || !ready.slack) {
    return { status: "skipped", reason: "connector_unavailable" };
  }

  const port = deps.port ?? createComposioGtasksSlackPort(deps.composio!);
  let tasks: GtaskInboxItem[];
  try {
    tasks = await port.listInboxTasks(ctx);
  } catch (error) {
    return { status: "error", message: sanitizeComposioError(error) };
  }

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

  const byScope = new Map<
    string,
    { workspaceId: string; userId: string; providers: Set<string> }
  >();
  for (const row of rows) {
    const key = `${row.workspaceId}:${row.userId}`;
    const entry = byScope.get(key) ?? {
      workspaceId: row.workspaceId,
      userId: row.userId,
      providers: new Set<string>(),
    };
    entry.providers.add(row.provider);
    byScope.set(key, entry);
  }

  return [...byScope.values()]
    .filter(
      (entry) =>
        entry.providers.has(GTASKS_SLACK_ROUTING.composioProviders.googleTasks) &&
        entry.providers.has(GTASKS_SLACK_ROUTING.composioProviders.slack),
    )
    .map(({ workspaceId, userId }) => ({ workspaceId, userId }));
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
