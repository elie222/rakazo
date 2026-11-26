import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { isQuestionAskBlock, resolveAskChoice } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { storedMessageBlocks } from "@rakazo/db";
import { neutralizeSpeakerLabels } from "../../runtime/context/history-speakers.js";
import { messageToAgentHistoryText } from "./reply-context.js";

type HistorySource = Parameters<typeof messageToAgentHistoryText>[0];

/** A restored turn already owns its question cards and the text returned by their answers. */
export async function checkpointAnswerHistory(
  prisma: PrismaClient,
  run: { id: string; threadId: string; botId: string },
  history: AgentRunRequest["history"],
  messages: readonly HistorySource[],
  labelled: boolean,
) {
  // Read independently of the history window: a reply can outlive the card it answers.
  const cards = await prisma.message.findMany({
    where: { runId: run.id, threadId: run.threadId, botId: run.botId, role: "bot" },
    select: { id: true, blocks: true },
  });
  const answers = new Map<
    string,
    {
      text: string;
      choiceId?: string;
      actions: Parameters<typeof resolveAskChoice>[1];
    }
  >();
  const cardIds = new Set<string>();
  for (const card of cards) {
    for (const block of storedMessageBlocks(card)) {
      if (
        block.kind !== "ask" ||
        !isQuestionAskBlock(block) ||
        block.status !== "answered" ||
        !block.answerMessageId ||
        !block.answer
      )
        continue;
      cardIds.add(card.id);
      answers.set(block.answerMessageId, {
        text: block.answer,
        choiceId: resolveAskChoice(block.answer, block.actions)?.id,
        actions: block.actions,
      });
    }
  }
  const representedMessageIds = [...cardIds];
  const answerReplyContexts = new Map<string, string>();
  const residuals = new Map<string, HistorySource>();
  // Steering messages may be absent from history but still need their answer text removed.
  for (const source of messages) {
    if (source.role !== "user") continue;
    const blocks = storedMessageBlocks(source);
    const answer = answers.get(source.id);
    const text = blocks
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    const removeAnswer =
      answer !== undefined &&
      (text === answer.text.trim() ||
        (answer.choiceId !== undefined &&
          resolveAskChoice(text, answer.actions)?.id === answer.choiceId));
    const target = source.replyTo;
    const removeQuotedCard = Boolean(target && cardIds.has(target.id));
    if (!removeAnswer && !removeQuotedCard) continue;
    const residual = {
      ...source,
      blocks: removeAnswer ? blocks.filter((block) => block.kind !== "text") : blocks,
      // Keep selected excerpts. Whole-card quotes (including reactions) must not repeat its answer.
      ...(removeQuotedCard && target
        ? {
            replyTo: {
              ...target,
              blocks: storedMessageBlocks(target).map((block) =>
                block.kind === "ask" && isQuestionAskBlock(block) && block.status === "answered"
                  ? {
                      ...block,
                      status: "pending" as const,
                      answer: undefined,
                      answerMessageId: undefined,
                    }
                  : block,
              ),
            },
          }
        : {}),
    };
    residuals.set(source.id, residual);
    if (removeAnswer)
      answerReplyContexts.set(source.id, messageToAgentHistoryText({ ...residual, blocks: [] }));
  }
  const projected = history.flatMap((entry) => {
    if (entry.id && cardIds.has(entry.id)) return [];
    const residual = entry.id ? residuals.get(entry.id) : undefined;
    if (!residual) return [entry];
    const content = labelled
      ? neutralizeSpeakerLabels(messageToAgentHistoryText(residual))
      : messageToAgentHistoryText(residual);
    if (!content.trim() && !entry.images?.length) {
      representedMessageIds.push(residual.id);
      return [];
    }
    return [{ ...entry, content }];
  });
  return { history: projected, representedMessageIds, answerReplyContexts };
}
