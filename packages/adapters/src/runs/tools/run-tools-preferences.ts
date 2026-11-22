import {
  ChatPreferencesPatchSchema,
  ChatPreferencesSchema,
  TimeZoneSchema,
} from "@rakazo/contracts";
import { accountPreferencesChangesScope, chatPreferencesSelect } from "@rakazo/db";
import { z } from "zod";
import { changeUserTimezone } from "../../tools/schedule-tools.js";
import type { RunContext } from "../assembly/run-context.js";
import { isSubagentToolExecution } from "../lifecycle/run-effects.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

const PreferencesPatchSchema = ChatPreferencesPatchSchema.extend({
  timezone: TimeZoneSchema.optional(),
  marketingEmails: z.boolean().optional(),
});

async function updatePreferences(ctx: RunContext, call: ToolCall) {
  const { deps, run, source } = ctx;
  if (!source.ownerStartedRun)
    return call.finish({ error: "Account preferences change only in a chat the user started." });
  const parsed = PreferencesPatchSchema.safeParse(call.args);
  if (!parsed.success)
    return call.finish({
      error: parsed.error.issues
        .map((issue) =>
          issue.code === "unrecognized_keys"
            ? `Unsupported account preferences: ${issue.keys.join(", ")}.`
            : `${issue.path.join(".")}: ${issue.message}`,
        )
        .join(" "),
    });
  const { timezone, marketingEmails, ...chatPreferences } = parsed.data;
  const changesChat = Object.values(chatPreferences).some((value) => value !== undefined);
  const write = timezone !== undefined || marketingEmails !== undefined || changesChat;
  if (write && isSubagentToolExecution(call.executionId))
    return call.finish({ error: "Helpers cannot change account preferences." });
  const select = {
    timezone: true,
    marketingEmailOptOutAt: true,
    ...chatPreferencesSelect,
  } as const;
  const where = { id: run.userId };
  const data = {
    ...chatPreferences,
    ...(marketingEmails === undefined
      ? {}
      : { marketingEmailOptOutAt: marketingEmails ? null : new Date() }),
  };
  if (timezone !== undefined) {
    // Routines that follow the account zone move in the same transaction as the preference changes.
    await changeUserTimezone(
      deps,
      run.userId,
      timezone,
      Object.keys(data).length ? data : undefined,
    );
  }
  const user =
    write && timezone === undefined
      ? await deps.prisma.user.update({ where, data, select })
      : await deps.prisma.user.findUniqueOrThrow({ where, select });
  if (changesChat)
    await deps.events.publishSpaceChange?.(
      accountPreferencesChangesScope(run.userId),
      "preferences",
    );
  return call.finish({
    timezone: user.timezone,
    marketingEmails: user.marketingEmailOptOutAt === null,
    ...ChatPreferencesSchema.parse(user),
  });
}

/** The account preferences of the user who started the run. */
export const preferenceTools: ToolHandlers = { update_preferences: updatePreferences };
