import type { ToolAsk } from "@rakazo/adapter-kit";
import type { ToolQuestion, ToolQuestionAnswer } from "@rakazo/contracts";
import { checkToolQuestionValues } from "@rakazo/contracts";
import { deadlineSignal, displayName } from "@rakazo/core";
import { createSealedBoxKey } from "@rakazo/core/node/sealed-box";
import { takeToolQuestionAnswer } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { RunContext } from "../assembly/run-context.js";
import { publishMessage } from "../assembly/run-messages.js";
import { notifyRun } from "../lifecycle/run-notifications.js";

/**
 * How long a tool's question waits for the person. The server holds its response to the call open
 * meanwhile, sending nothing; this stays well below the HTTP client's wait for a silent response
 * (MCP_HTTP_TIMEOUTS), so an answer always has a call to return to.
 */
export const TOOL_QUESTION_WAIT_MS = 10 * 60_000;

/**
 * Who a tool's server may ask mid-call: the person whose own message in the app started this
 * run. Routines, webhooks and email, other bots (a spawned bot's first run included: the person
 * is not in that chat waiting on it) and chat-app channels, which cannot show the card, have
 * nobody to ask, so their questions are declined.
 */
export function toolAskFor(ctx: RunContext): ToolAsk | undefined {
  if (
    !ctx.source?.ownerStartedRun ||
    ctx.source.messagingChannelRun ||
    ctx.run.trigger === "routine" ||
    ctx.run.trigger === "messaging"
  )
    return undefined;
  return (question, signal) => askInRun(ctx, question, signal);
}

async function askInRun(
  ctx: RunContext,
  question: ToolQuestion,
  signal: AbortSignal,
): Promise<ToolQuestionAnswer> {
  const { deps, run } = ctx;
  // Events from here on: an answer that lands before the wait starts is still heard.
  const cursor =
    (
      await deps.prisma.event.findFirst({
        where: { threadId: run.threadId },
        orderBy: { seq: "desc" },
        select: { seq: true },
      })
    )?.seq ?? 0;
  const expiresAt = new Date(Date.now() + TOOL_QUESTION_WAIT_MS).toISOString();
  // Only this call holds the private half: the answer is sealed to it on its way in, so no
  // reader of the chat sees what the person sent, and a restart leaves nothing readable behind.
  const key = createSealedBoxKey();
  const message = await publishMessage(deps, run, "bot", [
    { kind: "tool_question", question, status: "pending", expiresAt, publicKey: key.publicKey },
  ]);
  if (!message) return { action: "decline" };
  // As for any question the run asks: the person may be elsewhere. Only the integration's name is
  // sent, never the server's own text.
  await bestEffort(
    "tool question notification",
    notifyRun(deps, run, {
      kind: "help",
      title: `${displayName(ctx.bot.name, "Bot")} needs an answer`,
      body: question.source,
      botId: run.botId,
      threadId: run.threadId,
    }),
  );
  const ref = { spaceId: run.spaceId, threadId: message.threadId, messageId: message.id };
  const take = async (expire: boolean): Promise<ToolQuestionAnswer | undefined> => {
    const { answer, seq } = await takeToolQuestionAnswer(deps.prisma, ref, { expire });
    if (seq !== undefined) await bestEffort("tool question", deps.events.notify(ref.threadId, seq));
    if (answer?.action !== "accept") return answer;
    const opened = key.open(answer.sealedValues);
    const checked = opened === undefined ? undefined : parsedValues(question, opened);
    if (checked) return { action: "accept", values: checked };
    // The person accepted, but nothing this call can read came back: the server hears cancel.
    getLogger().warn("tool_question.unreadable_answer", {
      "run.id": run.id,
      opened: opened !== undefined,
    });
    return { action: "cancel" };
  };
  const wait = deadlineSignal(TOOL_QUESTION_WAIT_MS, AbortSignal.any([signal, ctx.context.signal]));
  try {
    // The answer commits with a card update on this thread; its signal reaches whichever
    // process holds this call, which then reads the answer from the row.
    for await (const event of deps.events.follow(ref.threadId, cursor, wait)) {
      if (event.type !== "thread.message.updated" || event.payload.messageId !== message.id)
        continue;
      const answer = await take(false);
      if (answer) return answer;
    }
  } catch (error) {
    if (!wait.aborted) {
      // A failed wait still closes the card: the server is told nobody answered.
      await bestEffort("tool question", take(true));
      throw error;
    }
    // The wait ended; a failure that is not that ending still leaves a trace.
    if (error !== wait.reason && !(error instanceof DOMException && error.name === "AbortError"))
      getLogger().warn("tool_question.wait_failed", { "run.id": run.id, error });
  }
  // The wait ended, the server withdrew the question or the run stopped: the card closes as
  // expired unless an answer got in first.
  return (await take(true)) ?? { action: "cancel" };
}

/** The values the API checked, checked again here: a box that does not hold them is no answer. */
function parsedValues(question: ToolQuestion, opened: string) {
  try {
    const values: unknown = JSON.parse(opened);
    if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
    const checked = checkToolQuestionValues(question.fields, values as Record<string, unknown>);
    return checked.ok ? checked.values : undefined;
  } catch {
    return undefined;
  }
}
