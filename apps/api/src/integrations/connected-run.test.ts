import { expect, it, vi } from "vitest";
import { queueConnectedRun } from "./connected-run.js";

const actor = {
  userId: "user",
  spaceId: "space",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

function tx(state: { thread?: boolean; archived?: boolean } = {}) {
  return {
    thread: { findFirst: vi.fn(async () => (state.thread === false ? null : { id: "thread" })) },
    bot: { findFirst: vi.fn(async () => (state.archived ? null : { id: "bot" })) },
    // A run already working in the chat does not hold the continuation back.
    run: {
      findFirst: vi.fn(async () => ({ id: "working" })),
      create: vi.fn(async () => ({ id: "carry-on" })),
    },
    task: { create: vi.fn(async () => ({ id: "task" })) },
  } as unknown as Parameters<typeof queueConnectedRun>[0];
}

const input = { botId: "bot", threadId: "thread", prompt: "carry on" };

it("queues the continuation even while the bot is busy in the chat", async () => {
  await expect(queueConnectedRun(tx(), actor, input)).resolves.toBe("carry-on");
});

it("queues nothing for a chat the bot left or an archived bot", async () => {
  await expect(queueConnectedRun(tx({ thread: false }), actor, input)).resolves.toBeNull();
  await expect(queueConnectedRun(tx({ archived: true }), actor, input)).resolves.toBeNull();
});
