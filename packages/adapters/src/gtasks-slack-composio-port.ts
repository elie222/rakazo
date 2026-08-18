import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ComposioProvider } from "./composio-connector.js";
import { GTASKS_SLACK_ROUTING } from "./gtasks-slack-config.js";
import type { GtaskInboxItem, GtasksSlackMirrorContext } from "./gtasks-slack-mirror.js";

export interface GtasksSlackPort {
  listInboxTasks(ctx: GtasksSlackMirrorContext): Promise<GtaskInboxItem[]>;
  postSlackMessage(ctx: GtasksSlackMirrorContext, text: string): Promise<{ messageTs: string }>;
  updateSlackMessage(
    ctx: GtasksSlackMirrorContext,
    messageTs: string,
    text: string,
  ): Promise<void>;
}

function adapterContext(ctx: GtasksSlackMirrorContext): AdapterContext {
  return {
    operationId: "integration.gtasks_slack.mirror",
    traceId: "integration.gtasks_slack.mirror",
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    signal: AbortSignal.timeout(60_000),
    connectedProviders: [
      GTASKS_SLACK_ROUTING.composioProviders.googleTasks,
      GTASKS_SLACK_ROUTING.composioProviders.slack,
    ],
  };
}

async function executeComposio(
  composio: ComposioProvider,
  ctx: GtasksSlackMirrorContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const events = composio.execute(
    { tool, args, executionId: `gtasks-slack:${tool}:${ctx.workspaceId}:${Date.now()}` },
    adapterContext(ctx),
  );
  let data: unknown;
  for await (const event of events) {
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "result") {
      const payload = event.data as { data?: unknown } | undefined;
      data = payload?.data ?? event.data;
    }
  }
  return data;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (Array.isArray(record?.items)) return record.items;
  if (Array.isArray(record?.tasks)) return record.tasks;
  if (Array.isArray(record?.task_lists)) return record.task_lists;
  if (Array.isArray(record?.taskLists)) return record.taskLists;
  return [];
}

function mapInboxTask(raw: unknown): GtaskInboxItem | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const id = String(record.id ?? record.task_id ?? record.taskId ?? "");
  const title = String(record.title ?? record.name ?? "");
  if (!id || !title) return undefined;
  return {
    id,
    title,
    notes: record.notes ? String(record.notes) : record.notes === "" ? "" : undefined,
    due: record.due ? String(record.due) : record.due_date ? String(record.due_date) : undefined,
    updated: record.updated ? String(record.updated) : undefined,
  };
}

async function resolveInboxListId(
  composio: ComposioProvider,
  ctx: GtasksSlackMirrorContext,
): Promise<string | undefined> {
  const data = await executeComposio(composio, ctx, GTASKS_SLACK_ROUTING.composioTools.listTaskLists, {
    max_results: 50,
  });
  for (const item of asArray(data)) {
    const record = asRecord(item);
    if (!record) continue;
    const title = String(record.title ?? record.name ?? "");
    if (title === GTASKS_SLACK_ROUTING.inboxListTitle) {
      return String(record.id ?? record.tasklist_id ?? "");
    }
  }
  const first = asRecord(asArray(data)[0]);
  return first ? String(first.id ?? first.tasklist_id ?? "") : undefined;
}

export function createComposioGtasksSlackPort(composio: ComposioProvider): GtasksSlackPort {
  return {
    async listInboxTasks(ctx) {
      const tasklistId = await resolveInboxListId(composio, ctx);
      if (!tasklistId) return [];
      const data = await executeComposio(composio, ctx, GTASKS_SLACK_ROUTING.composioTools.listTasks, {
        tasklist_id: tasklistId,
        show_completed: false,
        show_hidden: false,
      });
      return asArray(data)
        .map((item) => mapInboxTask(item))
        .filter((item): item is GtaskInboxItem => Boolean(item));
    },

    async postSlackMessage(ctx, text) {
      const data = asRecord(
        await executeComposio(composio, ctx, GTASKS_SLACK_ROUTING.composioTools.postMessage, {
          channel: GTASKS_SLACK_ROUTING.slackChannelId,
          text,
        }),
      );
      const messageTs = String(data?.ts ?? data?.message_ts ?? data?.messageTs ?? "");
      if (!messageTs) throw new Error("Slack mirror post did not return a message timestamp");
      return { messageTs };
    },

    async updateSlackMessage(ctx, messageTs, text) {
      await executeComposio(composio, ctx, GTASKS_SLACK_ROUTING.composioTools.updateMessage, {
        channel: GTASKS_SLACK_ROUTING.slackChannelId,
        ts: messageTs,
        text,
      });
    },
  };
}
