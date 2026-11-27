import { expect, it, vi } from "vitest";
import { primaryGroupHistory } from "./primary-group-continuity.js";

const scope = {
  botId: "recipient",
  spaceId: "space",
  threadId: "group-thread",
  userId: "owner",
  primaryRuntime: "fixture-runtime",
  modelProvider: "fixture-provider",
  modelId: "fixture-model",
  modelCredentialId: "recipient-connection",
  beforeSeq: 20,
  redactions: ["test-confidential-value"],
};

function row(id: string, seq: number, text: string) {
  return { id, seq, blocks: [{ kind: "text", text }] };
}

it("pairs only canonical earlier text from completed turns pinned to the same recipient", async () => {
  const recent = row("prompt-new", 12, "Second prompt");
  const earlier = row("prompt-old", 5, "First prompt: test-confidential-value");
  const prisma = {
    run: {
      findMany: vi.fn().mockResolvedValue([
        { id: "new", sourceMessage: recent },
        { id: "old", sourceMessage: earlier },
      ]),
    },
    message: {
      findMany: vi.fn().mockResolvedValue([
        { ...row("reply-new", 14, "Second reply"), runId: "new" },
        { ...row("reply-old", 7, "First reply"), runId: "old" },
      ]),
    },
  };
  const history = await primaryGroupHistory(prisma as never, scope);
  expect(history.map(({ id, role }) => [id, role])).toEqual([
    ["prompt-old", "user"],
    ["reply-old", "assistant"],
    ["prompt-new", "user"],
    ["reply-new", "assistant"],
  ]);
  expect(history[0]?.content).not.toContain("test-confidential-value");
  expect(prisma.run.findMany).toHaveBeenCalledExactlyOnceWith({
    where: {
      botId: "recipient",
      spaceId: "space",
      threadId: "group-thread",
      userId: "owner",
      primaryRuntime: "fixture-runtime",
      modelProvider: "fixture-provider",
      modelId: "fixture-model",
      modelCredentialId: "recipient-connection",
      modelPinned: true,
      status: "completed",
      trigger: "user",
      routineId: null,
      sourceMessage: {
        threadId: "group-thread",
        role: "user",
        authorUserId: "owner",
        seq: { lt: 20 },
      },
    },
    select: {
      id: true,
      sourceMessage: { select: { id: true, threadId: true, seq: true, blocks: true } },
    },
    orderBy: [{ sourceMessage: { seq: "desc" } }, { id: "desc" }],
    take: 3,
  });
  expect(prisma.message.findMany).toHaveBeenCalledExactlyOnceWith({
    where: {
      threadId: "group-thread",
      botId: "recipient",
      role: "bot",
      clientNonce: null,
      runId: { in: ["new", "old"] },
      seq: { lt: 20 },
    },
    select: { id: true, threadId: true, runId: true, seq: true, blocks: true },
    orderBy: { seq: "desc" },
    take: 3,
  });
});

it("drops pairs containing an invalid reply without replaying the earlier question alone", async () => {
  const prisma = {
    run: {
      findMany: vi.fn().mockResolvedValue([{ id: "run", sourceMessage: row("q", 5, "Ask") }]),
    },
    message: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: "a", seq: 6, runId: "run", blocks: [{ kind: "image", artifactId: "private" }] },
        ]),
    },
  };
  await expect(primaryGroupHistory(prisma as never, scope)).resolves.toEqual([]);
});
