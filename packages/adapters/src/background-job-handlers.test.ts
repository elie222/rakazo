import { describe, expect, it, vi } from "vitest";

const syncGtasksSlackInbox = vi.hoisted(() => vi.fn());

vi.mock("./gtasks-slack-mirror.js", () => ({ syncGtasksSlackInbox }));

import { createBackgroundJobHandlers } from "./background-job-handlers.js";

describe("background job handlers", () => {
  it("rejects failed Google Tasks mirror jobs with the sanitized message", async () => {
    syncGtasksSlackInbox.mockResolvedValueOnce({
      status: "error",
      message: "denied COMPOSIO_API_KEY=[redacted]",
    });
    const handlers = createBackgroundJobHandlers({
      executor: {} as never,
      prisma: {} as never,
      sandbox: {} as never,
      home: {} as never,
      jobs: {} as never,
      events: {} as never,
      workerId: "worker-1",
    });

    await expect(
      handlers["integration.gtasks_slack.mirror"]({ workspaceId: "ws-1", userId: "user-1" }),
    ).rejects.toThrow("denied COMPOSIO_API_KEY=[redacted]");
  });
});
