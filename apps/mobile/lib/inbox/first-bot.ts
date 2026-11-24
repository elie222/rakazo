import { isRetryableError } from "@rakazo/core";
import type { MobileSpace } from "../api/mobile-types";

type Navigation = {
  current: { id: string; bots: readonly unknown[]; groups: readonly unknown[] };
  spaces: readonly Pick<MobileSpace, "hasContent">[];
  /** Absent from a server that predates it. */
  firstBotDue?: boolean;
};

/** Each Space's answer this launch, so an empty inbox asks once and a reload joins the asking. */
const asked = new Map<string, Promise<string | null>>();

/**
 * A new account's inbox asks the server for its first bot. Only when no Space in sight has ever
 * held a chat and the server says one is still due: a Space whose bots were deleted counts as used,
 * so they are never brought back, and a new organization of someone who has chatted starts empty.
 */
export function needsFirstBot(navigation: Navigation): boolean {
  return (
    navigation.current.bots.length === 0 &&
    navigation.current.groups.length === 0 &&
    navigation.spaces.length > 0 &&
    navigation.spaces.every((space) => !space.hasContent) &&
    navigation.firstBotDue !== false
  );
}

/**
 * Asks once per session, server and Space, again after a failure that may pass. Resolves to the bot
 * the server made or found, or null when it made none or refused (a server that predates it); the
 * inbox then stays as it is.
 */
export function askFirstBot(
  key: string,
  request: () => Promise<{ botId: string | null }>,
): Promise<string | null> {
  const known = asked.get(key);
  if (known) return known;
  const answer = request().then(
    (result) => result.botId,
    (error: unknown) => {
      if (isRetryableError(error)) asked.delete(key);
      return null;
    },
  );
  asked.set(key, answer);
  return answer;
}

/** Tests only. */
export function forgetFirstBotRequests() {
  asked.clear();
}
