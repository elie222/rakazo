import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { threadLiveActivity } from "./run-live-activity.js";

function prismaWith(payload: unknown) {
  const findFirst = vi.fn(async () => (payload === undefined ? null : { id: "event-1", payload }));
  return { prisma: { event: { findFirst } } as unknown as Pick<PrismaClient, "event">, findFirst };
}

const running = [{ id: "run-1", status: "running", threadId: "thread-1" }];

describe("threadLiveActivity", () => {
  it("reads the step the running run shows last", async () => {
    const { prisma, findFirst } = prismaWith({ text: " Reading  q3-report.pdf\n", activity: true });
    await expect(threadLiveActivity(prisma, running, "thread-1")).resolves.toEqual({
      kind: "step",
      text: "Reading q3-report.pdf",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: "run-1", type: "thread.progress" },
        orderBy: { seq: "desc" },
      }),
    );
  });

  it("keeps a long step short", async () => {
    const { prisma } = prismaWith({ text: `Running: ${"x".repeat(300)}`, activity: true });
    const activity = await threadLiveActivity(prisma, running, "thread-1");
    expect(activity?.kind === "step" && activity.text.length).toBeLessThanOrEqual(120);
  });

  it("says the bot is writing while reply text streams", async () => {
    const { prisma } = prismaWith({ delta: " ", streaming: true });
    await expect(threadLiveActivity(prisma, running, "thread-1")).resolves.toEqual({
      kind: "writing",
    });
  });

  it("is empty while the bot thinks, or has shown nothing yet", async () => {
    await expect(
      threadLiveActivity(prismaWith({ text: "", activity: true }).prisma, running, "thread-1"),
    ).resolves.toBeUndefined();
    await expect(
      threadLiveActivity(prismaWith(undefined).prisma, running, "thread-1"),
    ).resolves.toBeUndefined();
    await expect(
      threadLiveActivity(prismaWith(["not", "a", "payload"]).prisma, running, "thread-1"),
    ).resolves.toBeUndefined();
  });

  it("reads nothing for work that is not running in this chat", async () => {
    const { prisma, findFirst } = prismaWith({ text: "Reading", activity: true });
    await expect(threadLiveActivity(prisma, running, "group-thread")).resolves.toBeUndefined();
    await expect(
      threadLiveActivity(
        prisma,
        [
          { id: "run-1", status: "running", threadId: "thread-1" },
          { id: "run-2", status: "waiting_input", threadId: "thread-1" },
        ],
        "thread-1",
      ),
    ).resolves.toBeUndefined();
    await expect(threadLiveActivity(prisma, [], "thread-1")).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
