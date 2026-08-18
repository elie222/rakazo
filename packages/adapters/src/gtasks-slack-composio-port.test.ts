import type { ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { ComposioProvider } from "./composio-connector.js";
import { GTASKS_SLACK_ROUTING } from "./gtasks-slack-config.js";
import { createComposioGtasksSlackPort } from "./gtasks-slack-composio-port.js";

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
  } as ComposioProvider;
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
});
