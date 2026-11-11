import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { publishMessage } from "./run-messages.js";

const run = {
  id: "run-1",
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  trigger: "silent_routine",
};
const file = {
  kind: "file" as const,
  artifactId: "artifact-1",
  name: "report.csv",
  mimeType: "text/csv",
  size: 10,
};

describe("a silent routine's mid-turn messages", () => {
  it("keep what they would have posted for the run history, not the chat", async () => {
    const append = vi.fn(async () => ({}));
    const transaction = vi.fn();
    const lease = { runId: "run-1", owner: "worker-1", fence: 3 };
    const deps = {
      events: { append },
      prisma: { $transaction: transaction },
      runLease: lease,
    } as unknown as ExecutorDeps;
    await expect(publishMessage(deps, run, "bot", [file])).resolves.toBeNull();
    expect(append).toHaveBeenCalledExactlyOnceWith({
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      type: "run.reply",
      payload: { blocks: [file] },
      // A superseded attempt holds an old lease, so it can't write the history twice.
      lease,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("keep nothing for ticket work, which reports on the board", async () => {
    const append = vi.fn(async () => ({}));
    const deps = { events: { append }, prisma: {} } as unknown as ExecutorDeps;
    await expect(
      publishMessage(deps, { ...run, trigger: "tickets" }, "bot", [file]),
    ).resolves.toBeNull();
    expect(append).not.toHaveBeenCalled();
  });
});
