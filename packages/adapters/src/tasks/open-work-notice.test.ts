import { blocksToAgentHistoryText } from "@rakazo/core";
import { beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  createThreadMessageInTransaction: vi.fn(),
  appendEventInTransaction: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  ...db,
}));

import { postOpenWorkNotice } from "./open-work-notice.js";

const notify = vi.fn(async () => undefined);
const deps = {
  prisma: { $transaction: async (run: (client: unknown) => Promise<unknown>) => run({}) },
  events: { notify },
} as unknown as Parameters<typeof postOpenWorkNotice>[0];
const input = { spaceId: "space-1", threadId: "thread-1", botId: "bot-1", itemId: "item-1" };

beforeEach(() => {
  vi.clearAllMocks();
  db.createThreadMessageInTransaction.mockResolvedValue({ id: "message-1" });
  db.appendEventInTransaction.mockResolvedValue({ seq: 7 });
});

it("writes a system message holding only the item and its title", async () => {
  await postOpenWorkNotice(deps, { ...input, title: "x".repeat(250) });
  const [, message] = db.createThreadMessageInTransaction.mock.calls[0]!;
  expect(message).toMatchObject({ threadId: "thread-1", role: "system", botId: "bot-1" });
  expect(message.markUnread).toBeUndefined();
  expect(message.blocks).toEqual([
    { kind: "open_work_event", itemId: "item-1", title: "x".repeat(200) },
  ]);
  // The model's history never gets the row, so a title cannot pass for an instruction.
  expect(blocksToAgentHistoryText(message.blocks)).toBe("");
  expect(db.appendEventInTransaction.mock.calls[0]![1]).toMatchObject({
    type: "thread.message.created",
    payload: { messageId: "message-1", role: "system", blocks: message.blocks },
  });
  expect(notify).toHaveBeenCalledWith("thread-1", 7);
});

it("never fails the save it reports", async () => {
  db.createThreadMessageInTransaction.mockRejectedValue(new Error("database down"));
  await expect(postOpenWorkNotice(deps, { ...input, title: "Ship" })).resolves.toBeUndefined();
  expect(notify).not.toHaveBeenCalled();
});
