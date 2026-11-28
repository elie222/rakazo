import { describe, expect, it } from "vitest";
import { readThreadHistory } from "./run-assembly-history.js";

type ReadHistoryInput = Parameters<typeof readThreadHistory>;

function reply(seq: number, text: string, earlierRoutineResult = false) {
  return {
    id: `message-${seq}`,
    seq,
    role: "bot",
    blocks: [{ kind: "text", text }],
    steeringMessages: [],
    earlierRoutineResult,
  };
}

async function routineHistory(messages: ReturnType<typeof reply>[], cursor: number | null = null) {
  const { compactedHistory, threadContext } = await readThreadHistory(
    { deps: { prisma: {} }, run: { trigger: "routine" } } as ReadHistoryInput[0],
    {
      records: {
        bot: { id: "bot" },
        historyReach: "recent",
        messages: [...messages].reverse(),
        thread: {
          historyCompactionSummary: "Private summary",
          historyCompactedUpToSeq: cursor,
        },
      } as unknown as ReadHistoryInput[1]["records"],
    },
  );
  return { ...compactedHistory, includeSemanticRecall: threadContext.includeSemanticRecall };
}

describe("routine history alongside chat", () => {
  it("clips oversized chat replies and earlier results", async () => {
    const text = "A".repeat(30_000);
    const { history } = await routineHistory([reply(1, text, true), reply(2, text)]);
    expect(history.map((message) => message.content)).toEqual(
      Array(2).fill(`${"A".repeat(1_990)}\n[clipped]`),
    );
  });

  it("drops the oldest recent replies when the replay budget is full", async () => {
    const text = "A".repeat(2_000);
    const recent = Array.from({ length: 10 }, (_, index) => reply(index + 2, text));
    const { history } = await routineHistory([reply(1, "Earlier result", true), ...recent]);
    expect(history.map((message) => message.seq)).toEqual([1, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("excludes compacted replies without using summary or recall", async () => {
    const { history, summary, includeSemanticRecall } = await routineHistory(
      [reply(1, "Earlier result", true), reply(2, "At the cursor"), reply(3, "After the cursor")],
      2,
    );
    expect(history.map((message) => message.seq)).toEqual([3]);
    expect(summary).toBeNull();
    expect(includeSemanticRecall).toBe(false);
  });
});
