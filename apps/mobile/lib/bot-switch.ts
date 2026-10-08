/** Match standalone switching requests, allowing polite openers and punctuation. */
const SWITCH_REQUEST =
  /^(?:(?:please|hey|ok|okay|so|can you|could you|would you)[\s,]+)*(?:switch|swap|transfer|put me through|connect me|take me)(?:\s+(?:me|us|over|back|the chat|this chat))*\s+(?:to|with)\s+(.+?)[\s.!?]*$/i;

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
  // Match full names before stripping an optional article.
  const withoutPlease = spoken.replace(/\s+please$/, "");
  for (const wanted of [
    spoken,
    spoken.replace(/^the\s+/, ""),
    withoutPlease,
    withoutPlease.replace(/^the\s+/, ""),
  ]) {
    if (!wanted) continue;
    const exact = bots.filter((bot) => normalized(bot.name) === wanted);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
  }
  const firstName = withoutPlease.replace(/^the\s+/, "");
  const byFirstName = bots.filter((bot) => normalized(bot.name).split(" ")[0] === firstName);
  return byFirstName.length === 1 ? byFirstName[0] : undefined;
}

/** Keep hand-over requests in memory so links cannot open the microphone. */
const RING_WINDOW_MS = 10_000;
let pendingRing: { botId: string; at: number } | undefined;

export function ringOnArrival(botId: string, now = Date.now()): void {
  pendingRing = { botId, at: now };
}

/** True once, for the bot a hand-over just asked to ring; any other arrival drops the request. */
export function takeRingOnArrival(botId: string, now = Date.now()): boolean {
  const ring = pendingRing;
  pendingRing = undefined;
  return ring !== undefined && ring.botId === botId && now - ring.at <= RING_WINDOW_MS;
}
