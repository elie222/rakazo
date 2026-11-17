import { oc } from "@orpc/contract";
import * as z from "zod";
import { TimeZoneSchema } from "../account/preferences.js";
import { Id, IsoDate, ThinkingLevelSchema } from "../ids.js";
import { botId } from "../rpc/inputs.js";
import {
  ROUTINE_HISTORY_PAGE_SIZE,
  RoutineHistorySchema,
  RoutineRunCursorSchema,
} from "../runs/runs.js";
import {
  CreateRoutineInput,
  ROUTINE_MENTION_BATCH_MAX,
  ROUTINE_TRIGGER_REQUIRED,
  RoutineEmailSendersSchema,
  RoutineSchema,
} from "./routine.js";
import { RoutineWatchSchema } from "./routine-watch.js";

export const routinesRpc = {
  routines: {
    listForMentions: oc
      .input(z.object({ botIds: z.array(Id).min(1).max(ROUTINE_MENTION_BATCH_MAX) }))
      .output(z.array(z.object({ botId: Id, routines: z.array(RoutineSchema) }))),
    list: oc.input(botId).output(z.array(RoutineSchema)),
    history: oc
      .input(
        z.object({
          routineId: Id,
          before: RoutineRunCursorSchema.optional(),
          limit: z.number().int().min(1).max(ROUTINE_HISTORY_PAGE_SIZE).optional(),
        }),
      )
      .output(RoutineHistorySchema),
    create: oc.input(CreateRoutineInput).output(RoutineSchema),
    update: oc
      .input(
        z
          .object({
            routineId: Id,
            name: z.string().optional(),
            prompt: z.string().optional(),
            crons: z.array(z.string().min(1)).optional(),
            timezone: TimeZoneSchema.optional(),
            active: z.boolean().optional(),
            notify: z.boolean().optional(),
            inChat: z.boolean().optional(),
            webhookEnabled: z.boolean().optional(),
            githubEnabled: z.boolean().optional(),
            messageProvider: z
              .string()
              .min(1)
              .max(50)
              .regex(/^[a-z0-9._-]+$/i)
              .nullable()
              .optional(),
            /** Null removes the email trigger. */
            emailSenders: RoutineEmailSendersSchema.nullable().optional(),
            /** Null clears the routine's own model and runs it on the bot's. */
            modelProvider: z.string().trim().min(1).max(80).nullable().optional(),
            modelId: z.string().trim().min(1).max(200).nullable().optional(),
            thinkingLevel: ThinkingLevelSchema.nullable().optional(),
            /** ISO datetime to arm a never-run one-shot. */
            runAt: IsoDate.optional(),
            /** Null removes the change trigger. */
            watch: RoutineWatchSchema.nullable().optional(),
          })
          .superRefine((value, ctx) => {
            if (
              value.crons &&
              value.crons.length === 0 &&
              value.webhookEnabled === false &&
              value.githubEnabled === false &&
              value.messageProvider === null &&
              value.emailSenders === null &&
              value.watch === null
            ) {
              ctx.addIssue({
                code: "custom",
                message: ROUTINE_TRIGGER_REQUIRED,
                path: ["crons"],
              });
            }
          }),
      )
      .output(RoutineSchema),
    remove: oc.input(z.object({ routineId: Id })).output(z.object({ ok: z.literal(true) })),
    testRun: oc
      .input(
        z.object({
          routineId: Id,
          clientNonce: z.string().min(1).max(200).optional(),
        }),
      )
      .output(z.object({ runId: Id })),
  },
};
