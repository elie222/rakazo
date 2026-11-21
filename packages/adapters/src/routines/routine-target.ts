import type { PrismaClient } from "@rakazo/db";
import { argumentGiven } from "../bots/update-bot-patch.js";
import type { FleetRun } from "../tools/fleet-tools.js";
import { resolveBot } from "../tools/fleet-tools.js";

/** A schedule_list, schedule_update or schedule_cancel call on another bot's routines. */
export function reachesManagedRoutines(name: string, args: Record<string, unknown>): boolean {
  return (
    (name === "schedule_list" || name === "schedule_update" || name === "schedule_cancel") &&
    (argumentGiven(args.bot_id) || argumentGiven(args.bot_name))
  );
}

export type RoutinesTarget = { botId: string; threadId: string; groupThreadId?: string };

/**
 * Whose routines a schedule tool reaches: this bot's, limited to the group's thread in a group, or
 * a bot it manages (the request gate has checked bot management), across all of that bot's
 * threads, as its owner sees them.
 */
export async function findRoutinesTarget(
  run: {
    prisma: PrismaClient;
    fleetRun: FleetRun;
    botId: string;
    thread: { id: string; groupId: string | null };
  },
  name: string,
  args: Record<string, unknown>,
): Promise<RoutinesTarget | { error: string }> {
  const { botId, thread } = run;
  const own = {
    botId,
    threadId: thread.id,
    ...(thread.groupId ? { groupThreadId: thread.id } : {}),
  };
  if (!reachesManagedRoutines(name, args)) return own;
  // A prepared call carries both: the id it acts on and the name its card shows.
  const managed = await resolveBot(
    run.prisma,
    run.fleetRun,
    argumentGiven(args.bot_id) ? { bot_id: args.bot_id } : args,
  );
  if ("error" in managed) return { error: managed.error };
  // Naming itself keeps a group run to the group's routines.
  if (managed.id === botId) return own;
  return { botId: managed.id, threadId: managed.thread?.id ?? thread.id };
}
