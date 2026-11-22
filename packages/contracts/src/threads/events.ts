import * as z from "zod";
import { Id } from "../ids.js";

export const ProductEventType = z.enum([
  "thread.message.created",
  "thread.cleared",
  "thread.message.updated",
  "thread.message.reaction",
  "thread.progress",
  "thread.artifact",
  "thread.ask",
  "thread.choice",
  "thread.meta",
  "thread.computer",
  "thread.subagent",
  "thread.cloud_agent",
  "thread.call.ended",
  "run.started",
  "run.steering.claimed",
  "run.checkpointed",
  "run.waiting_input",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "computer.status",
  "computer.takeover.requested",
  "computer.takeover.granted",
  "computer.takeover.released",
  "computer.command",
  "memory.revised",
  "routine.created",
  "routine.updated",
  "routine.fired",
  "skill.teaching.started",
  "skill.teaching.stopped",
  "skill.draft.created",
  "skill.saved",
  "effect.recorded",
  "agent.tool.called",
  "agent.tool.completed",
  "effect.reconciled",
  "usage.recorded",
  "bot.spawned",
  "bot.updated",
  "bot.archived",
  "bot.deleted",
  "group.created",
  "group.updated",
  "group.handoff",
  /** Liveness only: never persisted, never applied to a snapshot, always seq 0. */
  "heartbeat",
]);
export type ProductEventType = z.infer<typeof ProductEventType>;

/** Coarse live run state. Never accepts provider reasoning content or partial messages. */
export const ThreadActivityPayloadSchema = z
  .object({
    activity: z.object({ thinking: z.boolean() }).strict(),
  })
  .strict();

/** Distinguish this live lifecycle subtype from unrelated thread metadata. */
export function hasThinkingActivityMarker(payload: Record<string, unknown>): payload is {
  activity: { thinking: unknown };
} {
  const activity = payload.activity;
  return activity !== null && typeof activity === "object" && "thinking" in activity;
}

export const ProductEventSchema = z
  .object({
    id: Id,
    spaceId: Id,
    threadId: Id,
    botId: Id,
    seq: z.number().int().nonnegative(),
    type: ProductEventType,
    runId: Id.optional(),
    createdAt: z.string(),
    payload: z.record(z.string(), z.unknown()),
  })
  .superRefine((event, ctx) => {
    if (event.type !== "thread.meta" || !hasThinkingActivityMarker(event.payload)) return;
    if (!event.runId || !ThreadActivityPayloadSchema.safeParse(event.payload).success) {
      ctx.addIssue({ code: "custom", path: ["payload"], message: "Invalid run activity" });
    }
  });
export type ProductEvent = z.infer<typeof ProductEventSchema>;
