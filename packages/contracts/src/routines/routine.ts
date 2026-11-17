import * as z from "zod";
import { TimeZoneSchema } from "../account/preferences.js";
import { Id, ThinkingLevelSchema } from "../ids.js";
import { RoutineWatchSchema, RoutineWatchStateSchema } from "./routine-watch.js";

/**
 * A routine's model is optional, but provider and id only mean something together,
 * and a thinking level belongs to a model this routine actually names.
 */
export function routineModelIssues(
  value: {
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: string | null;
  },
  ctx: { addIssue: (issue: { code: "custom"; message: string; path: string[] }) => void },
) {
  const providerProvided = value.modelProvider !== undefined && value.modelProvider !== null;
  const modelProvided = value.modelId !== undefined && value.modelId !== null;
  if (providerProvided !== modelProvided) {
    ctx.addIssue({
      code: "custom",
      message: "Model provider and model id must both be set or both cleared",
      path: ["modelId"],
    });
    return;
  }
  if (value.thinkingLevel && !providerProvided) {
    ctx.addIssue({
      code: "custom",
      message: "Pick a model for this routine first",
      path: ["thinkingLevel"],
    });
  }
}

export const ROUTINE_MENTION_BATCH_MAX = 100;

export const ROUTINE_TRIGGER_REQUIRED =
  "Add a schedule, webhook, GitHub, message, email, or change trigger";

/** Whose authenticated mail starts an email routine: the bot owner, or anyone at the owner's domain. */
export const RoutineEmailSendersSchema = z.enum(["owner", "domain"]);
export type RoutineEmailSenders = z.infer<typeof RoutineEmailSendersSchema>;

export const RoutineSchema = z.object({
  id: Id,
  botId: Id,
  name: z.string(),
  prompt: z.string(),
  crons: z.array(z.string()),
  timezone: z.string(),
  active: z.boolean(),
  notify: z.boolean(),
  /** Runs as a turn in its chat instead of alongside it. Absent on older servers. */
  inChat: z.boolean().default(false),
  webhookEnabled: z.boolean(),
  githubEnabled: z.boolean(),
  messageProvider: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9._-]+$/i)
    .nullable(),
  /** Null unless mail to the bot's address starts this routine. Absent on older servers. */
  emailSenders: RoutineEmailSendersSchema.nullable().default(null),
  /** Null runs this routine on its bot's model. */
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  thinkingLevel: ThinkingLevelSchema.nullable(),
  /** Null unless the routine starts when something changes. */
  watch: RoutineWatchSchema.nullable(),
  watchState: RoutineWatchStateSchema.nullable(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  /** Computed by the server; absent on older servers. Not a worker-health diagnosis. */
  scheduleDelayed: z.boolean().optional(),
  createdAt: z.string(),
  /** Older servers send false for another member's routine; any member can now change it. */
  editable: z.boolean().optional(),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const CreateRoutineInput = z
  .object({
    botId: Id,
    name: z.string().min(1).max(80),
    prompt: z.string().min(1),
    crons: z.array(z.string().min(1)).default([]),
    timezone: TimeZoneSchema.default("UTC"),
    notify: z.boolean().default(true),
    inChat: z.boolean().default(false),
    active: z.boolean().default(false),
    webhookEnabled: z.boolean().default(false),
    githubEnabled: z.boolean().default(false),
    messageProvider: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9._-]+$/i)
      .nullable()
      .default(null),
    emailSenders: RoutineEmailSendersSchema.nullable().default(null),
    modelProvider: z.string().trim().min(1).max(80).nullable().default(null),
    modelId: z.string().trim().min(1).max(200).nullable().default(null),
    thinkingLevel: ThinkingLevelSchema.nullable().default(null),
    watch: RoutineWatchSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    routineModelIssues(value, ctx);
    if (
      value.crons.length === 0 &&
      !value.webhookEnabled &&
      !value.githubEnabled &&
      !value.messageProvider &&
      !value.emailSenders &&
      !value.watch
    ) {
      ctx.addIssue({
        code: "custom",
        message: ROUTINE_TRIGGER_REQUIRED,
        path: ["crons"],
      });
    }
    if (value.watch && value.crons.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "A change trigger checks on its own interval; remove the schedule",
        path: ["watch"],
      });
    }
  });
export type CreateRoutineInput = z.infer<typeof CreateRoutineInput>;
