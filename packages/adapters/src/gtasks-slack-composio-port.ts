import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ComposioProvider } from "./composio-connector.js";
import { GTASKS_SLACK_ROUTING } from "./gtasks-slack-config.js";
import type { GtaskInboxItem, GtasksSlackMirrorContext } from "./gtasks-slack-mirror.js";

export interface GtasksSlackPort {
  listInboxTasks(ctx: GtasksSlackMirrorContext, signal: AbortSignal): Promise<GtaskInboxItem[]>;
  postSlackMessage(
    ctx: GtasksSlackMirrorContext,
    text: string,
    clientMessageId: string,
    signal: AbortSignal,
  ): Promise<{ messageTs: string }>;
  updateSlackMessage(
    ctx: GtasksSlackMirrorContext,
    messageTs: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void>;
}

function adapterContext(ctx: GtasksSlackMirrorContext, signal: AbortSignal): AdapterContext {
  return {
    operationId: "integration.gtasks_slack.mirror",
    traceId: "integration.gtasks_slack.mirror",
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    signal,
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
  signal: AbortSignal,
): Promise<unknown> {
  const events = composio.execute(
    { tool, args, executionId: `gtasks-slack:${tool}:${ctx.workspaceId}:${Date.now()}` },
    adapterContext(ctx, signal),
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

function nextPageToken(data: unknown, seen: Set<string>): string | undefined {
  const record = asRecord(data);
  const token = record?.nextPageToken ?? record?.next_page_token ?? record?.pageToken;
  if (typeof token !== "string" || token.length === 0 || seen.has(token)) return undefined;
  seen.add(token);
  return token;
}

function mapInboxTask(raw: unknown): GtaskInboxItem | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const id = String(record.id ?? record.task_id ?? record.taskId ?? "");
  const title = String(record.title ?? record.name ?? "");
  if (!id || !title) return undefined;
  const updated = typeof record.updated === "string" ? record.updated : "";
  const updatedAt = Date.parse(updated);
  if (!isGoogleTasksRevision(updated) || !Number.isFinite(updatedAt)) {
    throw new Error("Google Tasks item is missing a valid updated revision");
  }
  return {
    id,
    title,
    notes: record.notes ? String(record.notes) : record.notes === "" ? "" : undefined,
    due: record.due ? String(record.due) : record.due_date ? String(record.due_date) : undefined,
    updated: new Date(updatedAt).toISOString(),
  };
}

function isGoogleTasksRevision(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

async function resolveInboxListId(
  composio: ComposioProvider,
  ctx: GtasksSlackMirrorContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  do {
    const args: Record<string, unknown> = { max_results: 50 };
    if (pageToken) args.page_token = pageToken;
    const data = await executeComposio(
      composio,
      ctx,
      GTASKS_SLACK_ROUTING.composioTools.listTaskLists,
      args,
      signal,
    );
    for (const item of asArray(data)) {
      const record = asRecord(item);
      if (!record) continue;
      const title = String(record.title ?? record.name ?? "");
      if (title === GTASKS_SLACK_ROUTING.inboxListTitle) {
        return String(record.id ?? record.tasklist_id ?? "");
      }
    }
    pageToken = nextPageToken(data, seenPageTokens);
  } while (pageToken);
  return undefined;
}

export function createComposioGtasksSlackPort(composio: ComposioProvider): GtasksSlackPort {
  return {
    async listInboxTasks(ctx, signal) {
      const tasklistId = await resolveInboxListId(composio, ctx, signal);
      if (!tasklistId) return [];
      const tasks: GtaskInboxItem[] = [];
      let pageToken: string | undefined;
      const seenPageTokens = new Set<string>();
      do {
        const args: Record<string, unknown> = {
          tasklist_id: tasklistId,
          show_completed: false,
          show_hidden: false,
          max_results: 100,
        };
        if (pageToken) args.page_token = pageToken;
        const data = await executeComposio(
          composio,
          ctx,
          GTASKS_SLACK_ROUTING.composioTools.listTasks,
          args,
          signal,
        );
        for (const item of asArray(data)) {
          const mapped = mapInboxTask(item);
          if (mapped) tasks.push(mapped);
        }
        pageToken = nextPageToken(data, seenPageTokens);
      } while (pageToken);
      return tasks;
    },

    async postSlackMessage(ctx, text, clientMessageId, signal) {
      const data = asRecord(
        await executeComposio(
          composio,
          ctx,
          GTASKS_SLACK_ROUTING.composioTools.postMessage,
          {
            channel: GTASKS_SLACK_ROUTING.slackChannelId,
            text,
            client_msg_id: clientMessageId,
            link_names: false,
            unfurl_links: false,
            unfurl_media: false,
          },
          signal,
        ),
      );
      const messageTs = String(data?.ts ?? data?.message_ts ?? data?.messageTs ?? "");
      if (!messageTs) throw new Error("Slack mirror post did not return a message timestamp");
      return { messageTs };
    },

    async updateSlackMessage(ctx, messageTs, text, signal) {
      await executeComposio(
        composio,
        ctx,
        GTASKS_SLACK_ROUTING.composioTools.updateMessage,
        {
          channel: GTASKS_SLACK_ROUTING.slackChannelId,
          ts: messageTs,
          text,
          link_names: false,
        },
        signal,
      );
    },
  };
}
