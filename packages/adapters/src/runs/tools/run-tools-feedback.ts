import { FEEDBACK_DESCRIPTION_MAX_LENGTH, FEEDBACK_KINDS } from "@rakazo/contracts";
import { isBackgroundRunTrigger, redactSecrets } from "@rakazo/core";
import { THREAD_LOCK_TRANSACTION_OPTIONS, withTransactionRetry } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { z } from "zod";
import type { RunContext } from "../assembly/run-context.js";
import { persistMessageInTransaction, runLeaseFor } from "../assembly/run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";

const FeedbackSchema = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    description: z.string().trim().min(1).max(FEEDBACK_DESCRIPTION_MAX_LENGTH),
  })
  .strict();

/** Enough for a user reporting a few problems; stops a looping bot from filing dozens. */
export const FEEDBACK_REPORTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

async function sendFeedback(ctx: RunContext, call: ToolCall) {
  const { deps, run } = ctx;
  const parsed = FeedbackSchema.safeParse(call.args);
  if (!parsed.success)
    return call.finish({
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join(" "),
    });
  const recent = await deps.prisma.feedbackReport.count({
    where: { userId: run.userId, createdAt: { gte: new Date(Date.now() - HOUR_MS) } },
  });
  if (recent >= FEEDBACK_REPORTS_PER_HOUR)
    return call.finish({ error: "Too many reports in the last hour. Try again later." });
  const { kind, description } = parsed.data;
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(async (tx) => {
      const report = await tx.feedbackReport.create({
        data: {
          userId: run.userId,
          spaceId: run.spaceId,
          botId: run.botId,
          threadId: run.threadId,
          runId: run.id,
          kind,
          description: redactSecrets(description, ctx.secrets),
        },
        select: { id: true, description: true },
      });
      if (isBackgroundRunTrigger(run.trigger)) return { id: report.id, receipt: null };
      const receipt = await persistMessageInTransaction(
        tx,
        run,
        "bot",
        [
          {
            kind: "feedback_receipt",
            reportId: report.id,
            reportKind: kind,
            description: report.description,
          },
        ],
        run.trigger === "bot_message" ? false : undefined,
        undefined,
        false,
        runLeaseFor(deps, run.id),
      );
      return { id: report.id, receipt };
    }, THREAD_LOCK_TRANSACTION_OPTIONS),
  );
  if (committed.receipt)
    await bestEffort(
      "notify feedback receipt",
      deps.events.notify(
        run.threadId,
        committed.receipt.eventSeq,
        committed.receipt.firstResponseRunId,
      ),
    );
  return call.finish({ sent: true, id: committed.id });
}

/** Bug reports and product feedback the user asked their bot to send. */
export const feedbackTools: ToolHandlers = { feedback: sendFeedback };
