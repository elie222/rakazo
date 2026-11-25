import type { MessageBlock } from "@rakazo/contracts";
import { AGENT_IMPORT_ASK_ACTION_ID } from "@rakazo/contracts";
import { isQuestionAskBlock } from "./ask-kind.js";

export { askOptionLetter, isQuestionAskBlock } from "./ask-kind.js";

import { resolveAskChoice } from "./answerable-ask.js";

type Message = {
  id: string;
  role: string;
  blocks: readonly MessageBlock[];
};

/** Answers linked by the server to a user message currently visible in the transcript. */
export function separateAskAnswers(
  messages: readonly Message[],
): Map<string, ReadonlySet<MessageBlock>> {
  const answers = new Map<string, Set<MessageBlock>>();
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of messages) {
    if (message.role !== "bot") continue;
    for (const block of message.blocks) {
      if (
        block.kind !== "ask" ||
        !isQuestionAskBlock(block) ||
        block.status !== "answered" ||
        !block.answerMessageId ||
        !block.answer ||
        resolveAskChoice(block.answer, block.actions)
      )
        continue;
      const reply = byId.get(block.answerMessageId);
      if (reply?.role !== "user") continue;
      const text = reply.blocks
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .join("\n")
        .trim();
      // Cards answered before AGENT_IMPORT_ASK_ACTION_ID was excluded stored the action id while the linked reply holds the label.
      const legacyImportAnswer =
        block.answer.trim() === AGENT_IMPORT_ASK_ACTION_ID &&
        Boolean(
          block.actions?.some(
            (action) =>
              action.id === AGENT_IMPORT_ASK_ACTION_ID &&
              action.label.trim().toLowerCase() === text.toLowerCase(),
          ),
        );
      if (text && (block.answer.trim() === text || legacyImportAnswer)) {
        const repeated = answers.get(message.id) ?? new Set<MessageBlock>();
        repeated.add(block);
        answers.set(message.id, repeated);
      }
    }
  }
  return answers;
}
