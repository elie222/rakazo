import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { TeachRecordingEvent, TeachSnapshot } from "@rakazo/core";
import { buildPlaybookFromRecording } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { notifyRealtime } from "./event-stream.js";
import { appendEventInTransaction } from "./events.js";

type TaughtSkillRow = Prisma.TaughtSkillGetPayload<Record<string, never>>;

/**
 * Save a teaching recording as a draft, as stopping it does: its playbook is built from what was
 * recorded, and the stopped event commits with it. The caller holds the row lock.
 */
export async function draftTeachingRecordingInTransaction(
  tx: Prisma.TransactionClient,
  skill: TaughtSkillRow,
  input: { spaceId: string; reason: "stopped" | "expired"; stopSnapshot?: TeachSnapshot },
): Promise<{ skill: TaughtSkillRow; stopped: { threadId: string; seq: number } | null }> {
  const stored = (skill.recording ?? {}) as {
    events?: TeachRecordingEvent[];
    snapshots?: TeachSnapshot[];
  };
  const recording = {
    ...stored,
    events: Array.isArray(stored.events) ? [...stored.events] : [],
    snapshots: Array.isArray(stored.snapshots) ? [...stored.snapshots] : [],
  };
  if (input.stopSnapshot) {
    recording.snapshots.push(input.stopSnapshot);
    recording.events.push({
      at: input.stopSnapshot.at,
      kind: "snapshot",
      summary: input.stopSnapshot.summary,
    });
  }
  const playbook = buildPlaybookFromRecording(skill.goal, recording.events, recording.snapshots);
  const updated = await tx.taughtSkill.update({
    where: { id: skill.id },
    data: {
      status: "draft",
      recording: recording as never,
      playbook: playbook as never,
      stoppedAt: new Date(),
    },
  });
  // The stopped event must commit with the status flip; appended afterwards it is lost for
  // good when the process dies in between, because retries see a draft and skip it.
  const bot = await tx.bot.findUnique({
    where: { id: skill.botId },
    include: { thread: true },
  });
  if (!bot?.thread) return { skill: updated, stopped: null };
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: bot.thread.id,
    botId: skill.botId,
    type: "skill.teaching.stopped",
    payload: { skillId: skill.id, reason: input.reason },
  });
  return { skill: updated, stopped: { threadId: bot.thread.id, seq: event.seq } };
}

/**
 * A teaching recording lives exactly as long as the control it was recorded under: ending that
 * lease drafts it. Only recordings bound to this lease id are touched, under their row lock.
 */
export async function draftRecordingsOfLeaseInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; leaseId: string },
): Promise<Array<{ skillId: string; threadId: string; seq: number } | { skillId: string }>> {
  const bound = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM taught_skills
    WHERE status = 'recording' AND recording->>'controlLeaseId' = ${input.leaseId}
    FOR UPDATE`;
  const ended = [];
  for (const { id } of bound) {
    const skill = await tx.taughtSkill.findUniqueOrThrow({ where: { id } });
    const { stopped } = await draftTeachingRecordingInTransaction(tx, skill, {
      spaceId: input.spaceId,
      reason: "stopped",
    });
    ended.push(stopped ? { skillId: id, ...stopped } : { skillId: id });
  }
  return ended;
}

/** End the recordings of a lease that maintenance cleared on its own, outside a release. */
export async function draftRecordingsOfLease(
  prisma: PrismaClient,
  input: { spaceId: string; leaseId: string },
  realtime?: RealtimeFanout,
): Promise<string[]> {
  const drafted = await prisma.$transaction((tx) => draftRecordingsOfLeaseInTransaction(tx, input));
  for (const ended of drafted) {
    if ("seq" in ended) await notifyRealtime(realtime, ended.threadId, ended.seq);
  }
  return drafted.map((ended) => ended.skillId);
}
