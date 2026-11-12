import { runContinueJob, type JobPublisher } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, OPEN_WORK_LOOP_TRIGGER, isBackgroundRunTrigger } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { automated } from "./automated-messages.js";
import type { AgentLoopSettings } from "./agent-loop-settings.js";
import { listScratchpadItems, type ScratchpadToolDeps } from "./scratchpad-tools.js";

export const OPEN_WORK_LOOP_CHECKPOINT_KIND = "open_work_loop_v1";

export type OpenWorkLoopCheckpoint = {
  kind: typeof OPEN_WORK_LOOP_CHECKPOINT_KIND;
  missionStartedAtMs: number;
  rewakes: number;
  lastFingerprint: string;
  stallCount: number;
};

export function parseOpenWorkLoopCheckpoint(raw: string | null | undefined): OpenWorkLoopCheckpoint | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OpenWorkLoopCheckpoint>;
    if (parsed.kind !== OPEN_WORK_LOOP_CHECKPOINT_KIND) return null;
    if (typeof parsed.missionStartedAtMs !== "number") return null;
    return {
      kind: OPEN_WORK_LOOP_CHECKPOINT_KIND,
      missionStartedAtMs: parsed.missionStartedAtMs,
      rewakes: Math.max(0, Math.floor(parsed.rewakes ?? 0)),
      lastFingerprint: typeof parsed.lastFingerprint === "string" ? parsed.lastFingerprint : "",
      stallCount: Math.max(0, Math.floor(parsed.stallCount ?? 0)),
    };
  } catch {
    return null;
  }
}

export function serializeOpenWorkLoopCheckpoint(state: OpenWorkLoopCheckpoint): string {
  return JSON.stringify(state);
}

export async function listUnblockedOpenWork(
  deps: ScratchpadToolDeps,
  input: { spaceId: string; botId: string },
) {
  const items = await listScratchpadItems(deps, {
    spaceId: input.spaceId,
    botId: input.botId,
    status: "open",
  });
  return items;
}

export function openWorkFingerprint(
  items: ReadonlyArray<{ id: string; title: string; updatedAt: string }>,
): string {
  return items
    .map((item) => `${item.id}:${item.updatedAt}`)
    .sort()
    .join("|");
}

export const OPEN_WORK_LOOP_CONTINUATION_PROMPT = automated(
  "Open work remains on your scratchpad. Continue with the highest-value unblocked item. Mark items done only after you verify the result. Do not wait to be asked.",
);

export const OPEN_WORK_LOOP_STALL_NOTICE = automated(
  "Stopped re-waking this mission: open work did not change after several attempts. Review the scratchpad and send a message to continue.",
);

type ScheduleInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  userId: string;
  runId: string;
  trigger: string;
  checkpoint: string | null;
  blocks: MessageBlock[];
};

export type OpenWorkLoopDeps = {
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue">;
};

/**
 * After a text reply, schedule another run when unblocked open work remains.
 * Returns true when a continuation was queued (suppress finish notifications).
 */
export async function loadOpenWorkMissionCheckpoint(
  prisma: PrismaClient,
  input: { threadId: string; botId: string; checkpoint: string | null },
): Promise<OpenWorkLoopCheckpoint | null> {
  const current = parseOpenWorkLoopCheckpoint(input.checkpoint);
  if (current) return current;
  const prior = await prisma.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      trigger: OPEN_WORK_LOOP_TRIGGER,
      status: { in: ["completed", "failed", "cancelled"] },
    },
    orderBy: { updatedAt: "desc" },
    select: { checkpoint: true },
  });
  return parseOpenWorkLoopCheckpoint(prior?.checkpoint);
}

export async function maybeScheduleOpenWorkLoop(
  deps: OpenWorkLoopDeps,
  settings: AgentLoopSettings,
  input: ScheduleInput,
): Promise<boolean> {
  const { openWorkLoop } = settings;
  if (!openWorkLoop.enabled) return false;
  if (isBackgroundRunTrigger(input.trigger)) return false;
  if (!input.blocks.some((block) => block.kind === "text" && String(block.text ?? "").trim())) {
    return false;
  }

  const openItems = await listUnblockedOpenWork(deps, {
    spaceId: input.spaceId,
    botId: input.botId,
  });
  if (openItems.length === 0) return false;

  const waiting = await deps.prisma.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: ["waiting_input", "waiting_takeover"] },
    },
    select: { id: true },
  });
  if (waiting) return false;

  const active = await deps.prisma.run.findFirst({
    where: {
      threadId: input.threadId,
      botId: input.botId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
      id: { not: input.runId },
    },
    select: { id: true },
  });
  if (active) return false;

  const fingerprint = openWorkFingerprint(openItems);
  const previous = await loadOpenWorkMissionCheckpoint(deps.prisma, {
    threadId: input.threadId,
    botId: input.botId,
    checkpoint: input.checkpoint,
  });
  const now = Date.now();
  const missionStartedAtMs = previous?.missionStartedAtMs ?? now;
  const rewakes = (previous?.rewakes ?? 0) + 1;
  const stallCount =
    previous?.lastFingerprint === fingerprint ? (previous?.stallCount ?? 0) + 1 : 0;

  if (rewakes > openWorkLoop.maxRewakes) {
    await postLoopStatus(deps, input);
    return false;
  }
  if (now - missionStartedAtMs > openWorkLoop.maxWallClockMs) {
    await postLoopStatus(deps, input);
    return false;
  }
  if (stallCount >= openWorkLoop.stallThreshold) {
    await postLoopStatus(deps, input);
    return false;
  }

  const nextCheckpoint = serializeOpenWorkLoopCheckpoint({
    kind: OPEN_WORK_LOOP_CHECKPOINT_KIND,
    missionStartedAtMs,
    rewakes,
    lastFingerprint: fingerprint,
    stallCount,
  });

  const task = await deps.prisma.task.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      userId: input.userId,
      prompt: OPEN_WORK_LOOP_CONTINUATION_PROMPT,
      status: "queued",
    },
  });
  const run = await deps.prisma.run.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      threadId: input.threadId,
      taskId: task.id,
      userId: input.userId,
      status: "queued",
      trigger: OPEN_WORK_LOOP_TRIGGER,
      checkpoint: nextCheckpoint,
    },
  });
  await deps.jobs.enqueue(runContinueJob(run.id));
  return true;
}

async function postLoopStatus(deps: OpenWorkLoopDeps, input: ScheduleInput) {
  const blocks: MessageBlock[] = [{ kind: "text", text: OPEN_WORK_LOOP_STALL_NOTICE }];
  await deps.prisma.$transaction(async (tx) => {
    await createThreadMessageInTransaction(tx, {
      threadId: input.threadId,
      role: "bot",
      blocks,
      botId: input.botId,
    });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      type: "thread.message.created",
      payload: { role: "bot", blocks },
    });
  });
}
