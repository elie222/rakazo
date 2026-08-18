import { createHash } from "node:crypto";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import type { ComposioProvider } from "./composio-connector.js";
import { sanitizeComposioError } from "./composio-connector.js";
import { GTASKS_SLACK_LANE, GTASKS_SLACK_ROUTING } from "./gtasks-slack-config.js";
import { createComposioGtasksSlackPort, type GtasksSlackPort } from "./gtasks-slack-composio-port.js";

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

type MirrorAction = "created" | "updated" | "unchanged";

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
  const existing = await deps.prisma.integrationMirror.findUnique({
    where: {
      workspaceId_lane_externalId: {
        workspaceId: ctx.workspaceId,
        lane: GTASKS_SLACK_LANE,
        externalId: task.id,
      },
    },
  });

  if (existing?.fingerprint === fingerprint) return "unchanged";

  const text = formatGtaskSlackMirror(task);

  if (existing?.slackMessageTs) {
    await deps.port.updateSlackMessage(ctx, existing.slackMessageTs, text);
    await deps.prisma.integrationMirror.update({
      where: { id: existing.id },
      data: { fingerprint, updatedAt: new Date() },
    });
    await emitMirroredEvent(deps, ctx, task.id, "updated");
    return "updated";
  }

  try {
    const { messageTs } = await deps.port.postSlackMessage(ctx, text);
    await deps.prisma.integrationMirror.create({
      data: {
        workspaceId: ctx.workspaceId,
        lane: GTASKS_SLACK_LANE,
        externalId: task.id,
        fingerprint,
        slackMessageTs: messageTs,
      },
    });
    await emitMirroredEvent(deps, ctx, task.id, "created");
    return "created";
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await deps.prisma.integrationMirror.findUnique({
      where: {
        workspaceId_lane_externalId: {
          workspaceId: ctx.workspaceId,
          lane: GTASKS_SLACK_LANE,
          externalId: task.id,
        },
      },
    });
    if (raced?.fingerprint === fingerprint) return "unchanged";
    if (raced?.slackMessageTs) {
      await deps.port.updateSlackMessage(ctx, raced.slackMessageTs, text);
      await deps.prisma.integrationMirror.update({
        where: { id: raced.id },
        data: { fingerprint, updatedAt: new Date() },
      });
      await emitMirroredEvent(deps, ctx, task.id, "updated");
      return "updated";
    }
    throw error;
  }
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

  const byScope = new Map<string, { workspaceId: string; userId: string; providers: Set<string> }>();
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
