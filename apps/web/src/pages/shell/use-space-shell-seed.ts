import { useState } from "react";
import { peekBootstrapSeed } from "../../lib/bootstrap";
import { lastChatKey, lastChatOf, queryClient, spaceSeedKey } from "../../lib/query/query";

/**
 * A revisited space, or the shell reopened from another page, starts from what it showed last time
 * while its fresh bootstrap loads.
 */
export function useSpaceShellSeed(
  botId: string | undefined,
  groupId: string | undefined,
  userId: string | null,
  spaceId: string | null,
) {
  const [{ seed, startChat }] = useState(() => {
    const primed = peekBootstrapSeed(botId);
    if (primed) return { seed: primed, startChat: undefined };
    const cached = queryClient.getQueryData(spaceSeedKey(userId, spaceId));
    const lastChat = queryClient.getQueryData(lastChatKey(userId, spaceId));
    return { seed: cached, startChat: botId || groupId ? undefined : lastChatOf(cached, lastChat) };
  });
  return { seed, startChat };
}
