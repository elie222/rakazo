import * as z from "zod";
import { Id, IsoDate, RunStatus } from "./ids.js";

/** The computer provider refused a request at its own rate limit; the run tells the user to wait. */
export const COMPUTER_RATE_LIMIT_ERROR = "Too many computer requests. Try again later.";

export const RUN_TRIGGERS = [
  "user",
  "routine",
  "resume",
  "follow_up",
  "reaction",
  "call_end",
  "spawn",
  "skill",
  "bot_message",
  "webhook",
  "messaging",
  "cloud_agent",
  "purchase",
  "created",
  "tickets",
] as const;
export const RunTriggerSchema = z.enum(RUN_TRIGGERS);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

/**
 * Whose problem a failed run is. Every kind except "output" is the user's provider account,
 * key, plan or model choice; "output" is a model that returned nothing usable.
 */
export const RUN_ERROR_KINDS = [
  "key",
  "credit",
  "spending",
  "rate",
  "auth",
  "access",
  "model",
  "context",
  "output",
] as const;
export type RunErrorKind = (typeof RUN_ERROR_KINDS)[number];

export const RoutineRunSchema = z.object({
  id: Id,
  botId: Id,
  groupId: Id.nullable(),
  status: RunStatus,
  error: z.string().nullable(),
  createdAt: IsoDate,
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  messageId: Id.nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

export const RoutineRunCursorSchema = z.object({ id: Id, createdAt: IsoDate });
export type RoutineRunCursor = z.infer<typeof RoutineRunCursorSchema>;
/** Runs per history page; the first page a screen shows is shorter. */
export const ROUTINE_HISTORY_PAGE_SIZE = 20;
export const ROUTINE_HISTORY_FIRST_PAGE_SIZE = 5;
export const RoutineHistorySchema = z.object({
  runs: z.array(RoutineRunSchema),
  nextCursor: RoutineRunCursorSchema.nullable(),
});
export type RoutineHistory = z.infer<typeof RoutineHistorySchema>;

export const RunActivityRowSchema = z.object({
  runId: Id,
  botId: Id,
  botName: z.string(),
  groupId: Id.nullable(),
  groupName: z.string().nullable(),
  threadId: Id,
  status: RunStatus,
  trigger: RunTriggerSchema,
  notificationsEnabled: z.boolean(),
  promptSnippet: z.string(),
  agentMessage: z
    .discriminatedUnion("kind", [
      z.strictObject({
        fromBotName: z.string(),
        kind: z.enum(["update", "request"]),
        text: z.string().max(120),
      }),
      z.strictObject({ kind: z.literal("unknown") }),
    ])
    .nullable(),
  updatedAt: z.string(),
});
export type RunActivityRow = z.infer<typeof RunActivityRowSchema>;

export const RunsListOutputSchema = z.object({
  runs: z.array(RunActivityRowSchema),
});
export type RunsListOutput = z.infer<typeof RunsListOutputSchema>;
