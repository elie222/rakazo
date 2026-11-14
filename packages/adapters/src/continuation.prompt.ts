import { automated } from "./automated-messages.prompt.js";

// Sent in the user's role, so marked as automated: otherwise models read it as the user
// telling them never to stop, and keep going instead of asking.
export const SILENT_TOOL_CONTINUATION_PROMPT = automated(
  "Your last turn ended right after a tool result, without a reply. Continue the original task from the latest tool result. If you need information or a decision from the user, ask them instead of guessing; otherwise use any remaining tools needed, then give the user the final answer.",
);
// Sent after a reply was cut off by a dropped connection; the cut text is the previous turn.
export const CUT_REPLY_CONTINUATION_PROMPT = automated(
  "Your previous reply was cut off by a connection error. Continue exactly where it stopped, mid-word if needed, without repeating anything.",
);
/**
 * Sent after a reply ran out of output room. Models don't reliably tell a finished last word
 * from a cut one, or keep the space before the next word, so the continuation starts by
 * repeating the reply's last words, quoted here, and the join drops that repeat.
 */
export function cutReplyAtLimitPrompt(cut: string): string {
  const end = cut.trimEnd().slice(-200);
  const words = /(?:\S+\s+){0,5}\S+$/.exec(end)?.[0] ?? end;
  // Escaped so a quote mark in the reply can't end the quote early; line breaks stay as they
  // are, for the model to repeat them.
  const quoted = words.slice(-80).replace(/["\\]/g, "\\$&");
  return automated(
    `Your previous reply hit the output limit. It ended with: "${quoted}" Continue it: start by repeating those last words exactly, then carry on without repeating anything else.`,
  );
}
export const SILENT_ALLOWED_TOOL_CONTINUATION_PROMPT = automated(
  "Your last turn ended right after a tool result, without a reply. Continue the original task from the latest tool result. If you need information or a decision from the user, ask them instead of guessing, even if you were told to stay silent. Otherwise, if you were instructed to stay silent when there is nothing to report, follow that instruction for the entire final assistant reply; if not, use any remaining tools needed, then give the user the final answer.",
);
