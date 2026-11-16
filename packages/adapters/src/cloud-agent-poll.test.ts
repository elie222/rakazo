import type { CloudAgent } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { pollCloudAgent } from "./cloud-agent-poll.js";
import type { CloudAgentDeps } from "./cloud-agent-service.js";
import { cloudAgentBlock } from "./cloud-agent-service.js";

const agent = {
  id: "agent-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  messageId: "message-1",
  providerKey: "deployment",
  remoteId: null,
  launchDispatched: false,
  cancelRequested: false,
  status: "finished",
  title: "Fix the build",
  url: "https://agents.example.test/agent-1",
  nextPollAt: new Date(0),
  version: 1,
  generation: 1,
  wakeGeneration: 1,
} as unknown as CloudAgent;

/** Polls an agent that already ended, whose card in the chat holds `blocks`. */
async function pollWithCard(blocks: unknown) {
  const found = { id: "found" };
  const tx = {
    thread: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({ nextEventSeq: 1 })),
    },
    message: {
      findFirst: vi.fn(async () => ({ id: "message-1", blocks })),
      update: vi.fn(async () => ({})),
    },
    spaceMember: { findUnique: vi.fn(async () => found) },
    bot: { findFirst: vi.fn(async () => found) },
    cloudAgent: {
      findUnique: vi.fn(async () => agent),
      findUniqueOrThrow: vi.fn(async () => agent),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  await pollCloudAgent(
    {
      prisma,
      jobs: { enqueue: vi.fn() },
      events: { notify: vi.fn(async () => undefined) },
      cloudAgent: { key: "deployment", spaceId: "space-1", provider: {} },
    } as unknown as CloudAgentDeps,
    { agentId: agent.id },
  );
  return tx;
}

describe("the cloud agent card a poll keeps current", () => {
  const stray = [{ text: "no kind" }, null];
  const current = cloudAgentBlock(agent);
  const text = { kind: "text", text: "On it." };

  it.each([
    ["beside entries that are not blocks", [text, current, ...stray]],
    ["in a row that is not a list", { kind: "cloud_agent", agentId: agent.id }],
  ])("leaves the row alone when the card is current %s", async (_case, blocks) => {
    const tx = await pollWithCard(blocks);

    expect(tx.cloudAgent.updateMany).toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("replaces only the card, and writes the entries that are not blocks back as they were", async () => {
    const tx = await pollWithCard([text, { ...current, status: "running" }, ...stray]);

    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { blocks: [text, current, ...stray] },
    });
  });
});
