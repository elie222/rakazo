import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { deferFutureRoutine } from "./executor.js";

describe("routine scheduling", () => {
  it("never fires a future occurrence early", async () => {
    const scheduledAt = new Date(Date.now() + 60_000);
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };

    expect(await deferFutureRoutine(jobs, "routine-1", scheduledAt)).toBe(true);

    expect(enqueue).toHaveBeenCalledWith({
      name: "routine.wakeup",
      payload: { routineId: "routine-1", scheduledFor: scheduledAt.toISOString() },
      availableAt: scheduledAt,
      replaceKey: "routine:routine-1",
    });
  });
});
