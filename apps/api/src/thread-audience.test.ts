import { describe, expect, it, vi } from "vitest";
import { sendThreadMessage } from "./thread-target.js";

describe("private application sends during messaging runs", () => {
  it.each(["channel:group-1", "dm"])(
    "queues a separate private turn while %s is active",
    async (audience) => {
      const tx = {
        thread: { update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })) },
        message: {
          create: vi.fn(async () => ({ id: "private-message", seq: 1 })),
          update: vi.fn(),
        },
        run: {
          findFirst: vi.fn(async () => ({
            id: "group-run",
            taskId: "group-task",
            status: "running",
            audience,
          })),
        },
        steeringMessage: { create: vi.fn() },
        event: { create: vi.fn(async () => ({ seq: 1 })) },
      };
      const deps = {
        prisma: {
          $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
        },
        events: { notify: vi.fn(async () => undefined) },
        jobs: { enqueue: vi.fn() },
      };
      await sendThreadMessage(
        deps as never,
        { spaceId: "space-1", userId: "user-1" } as never,
        { kind: "bot", botId: "bot-1", threadId: "thread-1" } as never,
        { text: "Private test detail" },
      );
      expect(tx.steeringMessage.create).toHaveBeenCalledWith({
        data: { messageId: "private-message", botId: "bot-1", userId: "user-1", runId: null },
      });
      expect(tx.message.update).not.toHaveBeenCalled();
      expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    },
  );
});
