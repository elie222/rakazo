/**
 * "Switch to Max", "please put me through to Max", "can you swap me over to Max?":
 * the caller wants another bot, not a message for this one. Polite openers and trailing
 * punctuation are allowed; anything else around the request means it is a normal message.
 */
const SWITCH_REQUEST =
  /^(?:(?:please|hey|ok|okay|so|can you|could you|would you)[\s,]+)*(?:switch|swap|change|transfer|go|put me through|connect me|take me)(?:\s+(?:me|us|over|back|the chat|this chat))*\s+(?:to|with)\s+(.+?)(?:[\s,]+please)?[\s.!?]*$/i;

function normalized(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The bot the text asks to switch to: by full name, else by a unique first name. */
export function findSwitchTarget<T extends { id: string; name: string }>(
  text: string,
  bots: readonly T[],
): T | undefined {
  const asked = SWITCH_REQUEST.exec(text.trim())?.[1];
  if (!asked) return undefined;
  const spoken = normalized(asked);
  // A full name wins, so "The Planner" reaches its own bot before "the" is treated as
  // an article; only then is "the travel bot" read as "travel bot".
  for (const wanted of [spoken, spoken.replace(/^the\s+/, "")]) {
    if (!wanted) continue;
    const exact = bots.filter((bot) => normalized(bot.name) === wanted);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
  }
  const firstName = spoken.replace(/^the\s+/, "");
  const byFirstName = bots.filter((bot) => normalized(bot.name).split(" ")[0] === firstName);
  return byFirstName.length === 1 ? byFirstName[0] : undefined;
}
