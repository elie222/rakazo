import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { buildPotooRoutinePrompt } from "@rakazo/potoo";
import { resolveScheduleTiming } from "./schedule-tools.js";

export type PotooSeedBeat = {
  name: string;
  brief: string;
};

export type PotooSeedResult = {
  created: string[];
  skipped: string[];
};

export type PotooSeedOptions = {
  spaceId: string;
  userId: string;
  botId: string;
  threadId?: string;
  beats: PotooSeedBeat[];
  repo: string;
  date: string;
  cron: string;
  timezone?: string;
};

/**
 * Seed POTOO patrol routines for a bot. One routine per beat, named
 * `POTOO <beat>`; existing names are skipped so reseeding is safe.
 * Mirrors the schedule_create rollback: a failed wakeup enqueue deletes
 * the routine row instead of leaving a run that never fires.
 */
export async function seedPotooRoutines(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  options: PotooSeedOptions,
): Promise<PotooSeedResult> {
  const timezone = options.timezone ?? "UTC";
  const resolved = resolveScheduleTiming({ cron: options.cron }, timezone);
  if (!resolved.ok) throw new Error(resolved.error);
  const result: PotooSeedResult = { created: [], skipped: [] };
  for (const beat of options.beats) {
    const name = `POTOO ${beat.name}`;
    const existing = await deps.prisma.routine.findFirst({
      where: { spaceId: options.spaceId, botId: options.botId, name },
    });
    if (existing) {
      result.skipped.push(name);
      continue;
    }
    const prompt = buildPotooRoutinePrompt(beat.brief, {
      repo: options.repo,
      date: options.date,
      beatName: beat.name,
    });
    const row = await deps.prisma.routine.create({
      data: {
        spaceId: options.spaceId,
        botId: options.botId,
        userId: options.userId,
        threadId: options.threadId,
        name,
        prompt,
        crons: [resolved.cron],
        timezone,
        notify: true,
        active: true,
        nextRunAt: resolved.nextRunAt,
      },
    });
    try {
      await deps.jobs.enqueue(routineWakeupJob(row.id, resolved.nextRunAt));
    } catch (error) {
      await deps.prisma.routine.deleteMany({ where: { id: row.id } });
      throw error;
    }
    result.created.push(name);
  }
  return result;
}
