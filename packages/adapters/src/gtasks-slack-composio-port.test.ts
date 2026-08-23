import type { ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ComposioProvider } from "./composio-connector.js";
import { createComposioGtasksSlackPort } from "./gtasks-slack-composio-port.js";
import { GTASKS_SLACK_ROUTING } from "./gtasks-slack-config.js";

const ctx = { workspaceId: "workspace-1", userId: "user-1" };

function providerWithTasks(tasks: unknown[]): ComposioProvider {
  return {
    async *execute(call: ConnectorCall): AsyncIterable<ConnectorEvent> {
      const data =
        call.tool === GTASKS_SLACK_ROUTING.composioTools.listTaskLists
          ? { items: [{ id: "inbox-1", title: GTASKS_SLACK_ROUTING.inboxListTitle }] }
          : { tasks };
      yield { type: "result", data: { data } };
    },
  } as unknown as ComposioProvider;
}

describe("Google Tasks Composio port", () => {
  it("normalizes a valid source revision", async () => {
    const port = createComposioGtasksSlackPort(
      providerWithTasks([{ id: "task-1", title: "Task", updated: "2026-08-18T10:00:00-07:00" }]),
    );

    await expect(port.listInboxTasks(ctx, AbortSignal.timeout(1000))).resolves.toEqual([
      { id: "task-1", title: "Task", updated: "2026-08-18T17:00:00.000Z" },
    ]);
  });

  it.each([undefined, "not-a-date"])(
    "rejects a task with the invalid revision %s",
    async (updated) => {
      const port = createComposioGtasksSlackPort(
        providerWithTasks([{ id: "task-1", title: "Task", updated }]),
      );

      await expect(port.listInboxTasks(ctx, AbortSignal.timeout(1000))).rejects.toThrow(
        "valid updated revision",
      );
    },
  );

  it("does not fall back to a non-Inbox task list", async () => {
    const execute = vi.fn(async function* (call: ConnectorCall): AsyncIterable<ConnectorEvent> {
      yield {
        type: "result",
        data: {
          data:
            call.tool === "GOOGLETASKS_LIST_TASK_LISTS"
              ? { items: [{ id: "projects-1", title: "Projects" }] }
              : { tasks: [{ id: "wrong-task", title: "Wrong", updated: "2026-08-18T10:00:00Z" }] },
        },
      };
    });
    const port = createComposioGtasksSlackPort({ execute } as unknown as ComposioProvider);

    await expect(port.listInboxTasks(ctx, AbortSignal.timeout(1000))).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ tool: "GOOGLETASKS_LIST_TASK_LISTS" });
  });

  it("routes safe posts and updates only to the configured #tasks channel", async () => {
    const calls: ConnectorCall[] = [];
    const provider = {
      async *execute(call: ConnectorCall): AsyncIterable<ConnectorEvent> {
        calls.push(call);
        const data =
          call.tool === "SLACK_CHAT_POST_MESSAGE"
            ? { ts: "171.001" }
            : call.tool === "GOOGLETASKS_LIST_TASK_LISTS"
              ? { items: [{ id: "inbox-1", title: "My Tasks" }] }
              : call.tool === "GOOGLETASKS_LIST_TASKS"
                ? { tasks: [] }
                : { ok: true };
        yield { type: "result", data: { data } };
      },
    } as unknown as ComposioProvider;
    const port = createComposioGtasksSlackPort(provider);
    const signal = AbortSignal.timeout(1000);

    await port.listInboxTasks(ctx, signal);
    const posted = await port.postSlackMessage(ctx, "Safe task", "fixed-client-id", signal);
    await port.updateSlackMessage(ctx, posted.messageTs, "Changed task", signal);

    expect(calls).toEqual([
      expect.objectContaining({
        tool: "GOOGLETASKS_LIST_TASK_LISTS",
        args: { max_results: 50 },
      }),
      expect.objectContaining({
        tool: "GOOGLETASKS_LIST_TASKS",
        args: {
          tasklist_id: "inbox-1",
          show_completed: false,
          show_hidden: false,
          max_results: 100,
        },
      }),
      expect.objectContaining({
        tool: "SLACK_CHAT_POST_MESSAGE",
        args: {
          channel: "C0BQRCBPD51",
          text: "Safe task",
          client_msg_id: "fixed-client-id",
          link_names: false,
          unfurl_links: false,
          unfurl_media: false,
        },
      }),
      expect.objectContaining({
        tool: "SLACK_UPDATES_A_SLACK_MESSAGE",
        args: {
          channel: "C0BQRCBPD51",
          ts: "171.001",
          text: "Changed task",
          link_names: false,
        },
      }),
    ]);
  });

  it("paginates task-list discovery until it finds the Inbox", async () => {
    const calls: ConnectorCall[] = [];
    const provider = {
      async *execute(call: ConnectorCall): AsyncIterable<ConnectorEvent> {
        calls.push(call);
        if (call.tool === GTASKS_SLACK_ROUTING.composioTools.listTaskLists) {
          const data =
            call.args?.page_token === "lists-2"
              ? {
                  items: [{ id: "inbox-1", title: GTASKS_SLACK_ROUTING.inboxListTitle }],
                  pageToken: "lists-2",
                }
              : {
                  items: [{ id: "projects-1", title: "Projects" }],
                  next_page_token: "lists-2",
                };
          yield { type: "result", data: { data } };
          return;
        }
        yield { type: "result", data: { data: { tasks: [] } } };
      },
    } as unknown as ComposioProvider;
    const port = createComposioGtasksSlackPort(provider);

    await expect(port.listInboxTasks(ctx, AbortSignal.timeout(1000))).resolves.toEqual([]);
    expect(calls).toEqual([
      expect.objectContaining({
        tool: GTASKS_SLACK_ROUTING.composioTools.listTaskLists,
        args: { max_results: 50 },
      }),
      expect.objectContaining({
        tool: GTASKS_SLACK_ROUTING.composioTools.listTaskLists,
        args: { max_results: 50, page_token: "lists-2" },
      }),
      expect.objectContaining({
        tool: GTASKS_SLACK_ROUTING.composioTools.listTasks,
        args: expect.objectContaining({ tasklist_id: "inbox-1" }),
      }),
    ]);
  });

  it("stops task-list pagination when the provider repeats a page token", async () => {
    const calls: ConnectorCall[] = [];
    const provider = {
      async *execute(call: ConnectorCall): AsyncIterable<ConnectorEvent> {
        calls.push(call);
        const pageToken = call.args?.page_token;
        yield {
          type: "result",
          data: {
            data:
              pageToken === "lists-2"
                ? {
                    items: [{ id: "projects-2", title: "Projects 2" }],
                    pageToken: "lists-2",
                  }
                : {
                    items: [{ id: "projects-1", title: "Projects 1" }],
                    nextPageToken: "lists-2",
                  },
          },
        };
      },
    } as unknown as ComposioProvider;
    const port = createComposioGtasksSlackPort(provider);

    await expect(port.listInboxTasks(ctx, AbortSignal.timeout(1000))).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("paginates inbox task listing until the provider stops returning a next page token", async () => {
    const calls: ConnectorCall[] = [];
    const provider = {
      async *execute(call: ConnectorCall): AsyncIterable<ConnectorEvent> {
        calls.push(call);
        if (call.tool === GTASKS_SLACK_ROUTING.composioTools.listTaskLists) {
          yield {
            type: "result",
            data: {
              data: { items: [{ id: "inbox-1", title: GTASKS_SLACK_ROUTING.inboxListTitle }] },
            },
          };
          return;
        }
        const pageToken = call.args?.page_token;
        const tasks =
          pageToken === "page-2"
            ? [{ id: "task-2", title: "Second page", updated: "2026-08-18T11:00:00Z" }]
            : [{ id: "task-1", title: "First page", updated: "2026-08-18T10:00:00Z" }];
        const data =
          pageToken === "page-2"
            ? { tasks, pageToken: "page-2" }
            : { tasks, nextPageToken: "page-2" };
        yield { type: "result", data: { data } };
      },
    } as unknown as ComposioProvider;
    const port = createComposioGtasksSlackPort(provider);

    await expect(port.listInboxTasks(ctx, AbortSignal.timeout(1000))).resolves.toEqual([
      { id: "task-1", title: "First page", updated: "2026-08-18T10:00:00.000Z" },
      { id: "task-2", title: "Second page", updated: "2026-08-18T11:00:00.000Z" },
    ]);
    expect(
      calls.filter((call) => call.tool === GTASKS_SLACK_ROUTING.composioTools.listTasks),
    ).toHaveLength(2);
  });
});
