import { describe, expect, it, vi } from "vitest";

const { holdRunReplyInTransaction, persistMessageInTransaction } = vi.hoisted(() => ({
  holdRunReplyInTransaction: vi.fn(async () => ({})),
  persistMessageInTransaction: vi.fn(async () => ({ eventSeq: 1, firstResponseRunId: null })),
}));
vi.mock("./run-messages.js", () => ({ holdRunReplyInTransaction, persistMessageInTransaction }));

import { mediaDelivery } from "./media-video-poll.js";

describe("media delivery", () => {
  it("keeps a silent routine's image in its run history, not the chat", async () => {
    const tx = { externalEffect: { updateMany: vi.fn(async () => ({ count: 1 })) } };
    const notify = vi.fn(async () => undefined);
    const onSettled = vi.fn(async () => undefined);
    const run = {
      id: "run-1",
      threadId: "thread-1",
      botId: "bot-1",
      userId: "user-1",
      spaceId: "space-1",
    };
    const delivery = mediaDelivery(
      {
        prisma: { $transaction: async (write: (client: unknown) => unknown) => write(tx) },
        events: { notify },
        artifacts: {},
      } as never,
      run,
      { providerId: "fixture", operationId: "op-1", holdReply: true, onSettled },
    );
    const block = { kind: "image", artifactId: "artifact-1", name: "chart.png" };

    await delivery.publish(block as never, "job-1", "artifact-1");

    expect(holdRunReplyInTransaction).toHaveBeenCalledExactlyOnceWith(tx, run, [block]);
    expect(persistMessageInTransaction).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(tx, "completed");
    expect(notify).not.toHaveBeenCalled();
  });
});
