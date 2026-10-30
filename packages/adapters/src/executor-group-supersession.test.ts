import type * as DbModule from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

const cancelRuns = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  cancelRunsInTransaction: cancelRuns,
}));

it("cancels a peer before claiming it when a later user message supersedes its request", async () => {
  const run = {
    id: "peer",
    botId: "bot",
    taskId: "task",
    threadId: "thread",
    spaceId: "space",
    userId: "user",
    status: "queued",
    clientNonce: "local-group-team:root:bot",
  };
  const root = {
    id: "root",
    threadId: "thread",
    spaceId: "space",
    userId: "user",
    sourceMessage: { role: "user", seq: 7, threadId: "thread" },
  };
  const tx = { run: { updateMany: vi.fn(async () => ({ count: 1 })) } };
  const prisma = {
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "peer" ? run : root,
      ),
    },
    message: { findFirst: vi.fn(async () => ({ id: "replacement" })) },
    $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const executor = createRunExecutor({ prisma, jobs: { enqueue: vi.fn() } } as never);
  await executor.continueRun("peer", "worker");
  expect(prisma.message.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { threadId: "thread", role: "user", seq: { gt: 7 } } }),
  );
  expect(tx.run.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }),
  );
  expect(cancelRuns).toHaveBeenCalledOnce();
});
