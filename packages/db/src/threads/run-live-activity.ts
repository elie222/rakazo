import type { BotLiveActivity } from "@rakazo/contracts";
import { truncatePlainText } from "@rakazo/core";
import { z } from "zod";
import type { PrismaClient } from "../database/client.js";
import { readJsonColumn } from "../database/json-column.js";
import { primaryActiveRun } from "./thread-listing.js";

const STEP_MAX_CHARS = 120;

const ProgressPayload = z.object({
  text: z.string().optional(),
  delta: z.string().optional(),
  activity: z.boolean().optional(),
});

export async function threadLiveActivity(
  prisma: Pick<PrismaClient, "event">,
  runs: readonly { id: string; status: string; threadId: string }[],
  threadId: string | undefined,
): Promise<BotLiveActivity | undefined> {
  const run = primaryActiveRun(runs);
  if (run?.status !== "running" || run.threadId !== threadId) return undefined;
  const latest = await prisma.event.findFirst({
    where: { runId: run.id, type: "thread.progress" },
    orderBy: { seq: "desc" },
    select: { id: true, payload: true },
  });
  if (!latest) return undefined;
  const payload = readJsonColumn(
    ProgressPayload,
    latest.payload,
    { table: "events", column: "payload", id: latest.id },
    { fallback: {} },
  );
  const raw = payload.text ?? payload.delta ?? "";
  if (!payload.activity) return raw ? { kind: "writing" } : undefined;
  const text = raw.trim().replace(/\s+/g, " ");
  return text ? { kind: "step", text: truncatePlainText(text, STEP_MAX_CHARS) } : undefined;
}
