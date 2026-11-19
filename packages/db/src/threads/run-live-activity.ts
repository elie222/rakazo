import type { BotLiveActivity } from "@rakazo/contracts";
import { truncatePlainText } from "@rakazo/core";
import { z } from "zod";
import type { PrismaClient } from "../database/client.js";
import { Prisma } from "../database/client.js";
import { readJsonColumn } from "../database/json-column.js";
import { contentEncryptionOf } from "../encryption/content-encryption.js";
import { primaryActiveRun } from "./thread-listing.js";

const STEP_MAX_CHARS = 120;

const ProgressPayload = z.object({
  text: z.string().optional(),
  delta: z.string().optional(),
  activity: z.boolean().optional(),
  streaming: z.boolean().optional(),
});

type ActiveRun = { id: string; status: string; threadId: string };

export async function threadLiveActivities(
  prisma: Pick<PrismaClient, "$queryRaw">,
  threads: readonly { threadId: string | undefined; runs: readonly ActiveRun[] }[],
): Promise<Map<string, BotLiveActivity>> {
  const running = new Map<string, string>();
  for (const { threadId, runs } of threads) {
    const run = primaryActiveRun(runs.filter((candidate) => candidate.threadId === threadId));
    if (threadId && run?.status === "running") running.set(run.id, threadId);
  }
  if (running.size === 0) return new Map();
  const loaded = await prisma.$queryRaw<
    Array<{ id: string; runId: string; threadId: string; spaceId: string; payload: unknown }>
  >(Prisma.sql`
    SELECT e.id, e."runId", e."threadId", e."spaceId", e.payload
    FROM unnest(${[...running.keys()]}::text[]) AS r(id)
    CROSS JOIN LATERAL (
      SELECT id, "runId", "threadId", "spaceId", payload
      FROM events
      WHERE "runId" = r.id AND type = 'thread.progress'
      ORDER BY seq DESC
      LIMIT 1
    ) e
  `);
  const opened = (await contentEncryptionOf(prisma)?.openRows("Event", loaded)) ?? loaded;
  const activities = new Map<string, BotLiveActivity>();
  for (const event of opened) {
    const threadId = running.get(event.runId);
    const activity = progressActivity(event.id, event.payload);
    if (threadId && activity) activities.set(threadId, activity);
  }
  return activities;
}

function progressActivity(id: string, value: unknown): BotLiveActivity | undefined {
  const payload = readJsonColumn(
    ProgressPayload,
    value,
    { table: "events", column: "payload", id },
    { fallback: {} },
  );
  const raw = payload.text ?? payload.delta ?? "";
  if (!payload.activity) return payload.streaming && raw ? { kind: "writing" } : undefined;
  const text = raw.trim().replace(/\s+/g, " ");
  return text ? { kind: "step", text: truncatePlainText(text, STEP_MAX_CHARS) } : undefined;
}
