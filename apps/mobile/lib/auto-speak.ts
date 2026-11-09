import type { MessageBlock } from "@rakazo/contracts";

/**
 * What read-aloud speaks: the reply's own words only. Working narration
 * (progress, steps, tool calls) and system notes are status, not the message:
 * they sit before the reply's text, so reading them puts a stray sentence
 * ahead of the message the caller asked to hear.
 */
export function readAloudText(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block) => block.kind === "text" || block.kind === "ask")
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

const IN_PROGRESS_RUN_STATUSES = new Set(["running", "queued", "leased"]);

export type AutoSpeakMessage = {
  id: string;
  role: string;
  blocks: MessageBlock[];
};

export type AutoSpeakDecision =
  | { action: "seed"; messageId: string | null }
  | { action: "wait" }
  | { action: "speak"; messageId: string; text: string };

/** Same speak-on-finish gate as web Shell: skip history, wait out in-flight runs. */
export function nextAutoSpeakAction(input: {
  botId: string;
  autoSpeak: boolean;
  /** An active call owns the speaker; replies only seed while it lasts. */
  callActive: boolean;
  focused: boolean;
  snapshotReady: boolean;
  lastSpokenBotId: string | null;
  lastSpokenMessageId: string | null;
  runStatus?: string | null;
  messages: ReadonlyArray<AutoSpeakMessage>;
}): AutoSpeakDecision {
  if (!input.snapshotReady) return { action: "wait" };
  const lastBot = [...input.messages].reverse().find((message) => message.role === "bot");
  const lastBotId = lastBot?.id ?? null;
  if (input.lastSpokenBotId !== input.botId) {
    return { action: "seed", messageId: lastBotId };
  }
  // An active call owns the speaker: seed before the run and focus gates, so a
  // reply that streams during the call stays unspoken once the call ends.
  if (input.callActive || !input.autoSpeak) {
    return { action: "seed", messageId: lastBotId };
  }
  if (!input.focused) return { action: "wait" };
  if (input.runStatus && IN_PROGRESS_RUN_STATUSES.has(input.runStatus)) {
    return { action: "wait" };
  }
  if (!lastBot || lastBot.id === input.lastSpokenMessageId) return { action: "wait" };
  const text = readAloudText(lastBot.blocks);
  if (!text) return { action: "seed", messageId: lastBot.id };
  return { action: "speak", messageId: lastBot.id, text };
}
