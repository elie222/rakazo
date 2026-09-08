import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { messageReaction } from "@rakazo/core";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../prisma/migrations/20260908090000_message_reaction/migration.sql",
  ),
  "utf8",
);

type LegacyMessage = {
  id: string;
  threadId: string;
  seq: number;
  thumbsUp: boolean;
};

type Thread = { id: string; nextMessageSeq: number };

type ReactionRow = {
  id: string;
  threadId: string;
  seq: number;
  role: "user";
  blocks: [{ kind: "text"; text: "👍" }];
  replyToMessageId: string;
};

/** In-memory stand-in for the thumbsUp → emoji-reply backfill in the migration SQL. */
function backfillThumbsUp(threads: Thread[], messages: LegacyMessage[]) {
  const nextThreads = threads.map((thread) => ({ ...thread }));
  const byThread = new Map<string, LegacyMessage[]>();
  for (const message of messages.filter((row) => row.thumbsUp)) {
    const list = byThread.get(message.threadId) ?? [];
    list.push(message);
    byThread.set(message.threadId, list);
  }
  const inserted: ReactionRow[] = [];
  for (const thread of nextThreads) {
    const ranked = (byThread.get(thread.id) ?? []).sort((a, b) => a.seq - b.seq);
    if (ranked.length === 0) continue;
    const startSeq = thread.nextMessageSeq;
    thread.nextMessageSeq += ranked.length;
    for (const [index, parent] of ranked.entries()) {
      inserted.push({
        id: `reaction-${parent.id}`,
        threadId: thread.id,
        seq: startSeq + index,
        role: "user",
        blocks: [{ kind: "text", text: "👍" }],
        replyToMessageId: parent.id,
      });
    }
  }
  return { threads: nextThreads, reactions: inserted };
}

describe("message_reaction thumbsUp backfill", () => {
  it("converts thumbsUp rows into 👍 user replies before dropping the column", () => {
    expect(migrationSql).toMatch(/FROM "messages" WHERE "thumbsUp" = true/);
    expect(migrationSql).toMatch(
      /INSERT INTO "messages" \(id, "threadId", seq, role, blocks, "replyToMessageId", "createdAt"\)/,
    );
    expect(migrationSql).toMatch(/'\[\{"kind":"text","text":"👍"\}\]'::jsonb/);
    expect(migrationSql).toMatch(/'reaction-' \|\| ranked\.id/);
    expect(migrationSql).toMatch(
      /SET "nextMessageSeq" = thread\."nextMessageSeq" \+ counts\.total/,
    );
    expect(migrationSql).toMatch(/ALTER TABLE "messages" DROP COLUMN "thumbsUp"/);
    const dropAt = migrationSql.indexOf('DROP COLUMN "thumbsUp"');
    const insertAt = migrationSql.indexOf("INSERT INTO");
    expect(insertAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(insertAt);
  });

  it("allocates thread seqs and shapes rows like reactToThreadMessage", () => {
    const { threads, reactions } = backfillThumbsUp(
      [
        { id: "thread-a", nextMessageSeq: 10 },
        { id: "thread-b", nextMessageSeq: 3 },
      ],
      [
        { id: "msg-1", threadId: "thread-a", seq: 2, thumbsUp: true },
        { id: "msg-2", threadId: "thread-a", seq: 5, thumbsUp: false },
        { id: "msg-3", threadId: "thread-a", seq: 7, thumbsUp: true },
        { id: "msg-4", threadId: "thread-b", seq: 1, thumbsUp: false },
      ],
    );
    expect(threads).toEqual([
      { id: "thread-a", nextMessageSeq: 12 },
      { id: "thread-b", nextMessageSeq: 3 },
    ]);
    expect(reactions).toEqual([
      {
        id: "reaction-msg-1",
        threadId: "thread-a",
        seq: 10,
        role: "user",
        blocks: [{ kind: "text", text: "👍" }],
        replyToMessageId: "msg-1",
      },
      {
        id: "reaction-msg-3",
        threadId: "thread-a",
        seq: 11,
        role: "user",
        blocks: [{ kind: "text", text: "👍" }],
        replyToMessageId: "msg-3",
      },
    ]);
    for (const reaction of reactions) {
      expect(messageReaction(reaction)).toBe("👍");
    }
  });

  it("is a no-op when no thumbsUp rows exist", () => {
    const { threads, reactions } = backfillThumbsUp(
      [{ id: "thread-a", nextMessageSeq: 4 }],
      [{ id: "msg-1", threadId: "thread-a", seq: 1, thumbsUp: false }],
    );
    expect(threads[0]?.nextMessageSeq).toBe(4);
    expect(reactions).toEqual([]);
  });
});
