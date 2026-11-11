import type { MessageBlock } from "@rakazo/contracts";
import { isSecretAskBlock } from "./action-approval.js";

type Message = {
  id: string;
  role: string;
  botId?: string;
  blocks: readonly MessageBlock[];
};

/** Recorded answers repeated by the next visible user message, in reading order. */
export function separateAskAnswers(messages: readonly Message[]): Map<string, string> {
  const answers = new Map<string, string>();
  for (let index = 0; index < messages.length - 1; index++) {
    const message = messages[index]!;
    const reply = messages[index + 1]!;
    if (message.role !== "bot" || reply.role !== "user") continue;
    const text = reply.blocks
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    if (!text || (reply.botId && message.botId && reply.botId !== message.botId)) continue;
    if (
      message.blocks.some(
        (block) =>
          block.kind === "ask" &&
          block.status === "answered" &&
          !isSecretAskBlock(block) &&
          !block.approvalEffectId &&
          !block.instructionUpdate &&
          block.answer?.trim() === text,
      )
    )
      answers.set(message.id, text);
  }
  return answers;
}
