import type { SearchHit } from "@rakazo/contracts";

/**
 * Message id to open, if the hit is a row inside a thread.
 * A conversation hit is the thread itself and opens on the newest message.
 */
export function searchHitMessageId(hit: SearchHit): string | undefined {
  if (hit.kind === "conversation") return undefined;
  return hit.messageId;
}

export function mobileSearchDestination(hit: SearchHit):
  | {
      pathname: "/routine";
      params: { botId: string; botName: string; routineId: string };
    }
  | {
      pathname: "/group-thread";
      params: { groupId: string; name: string; messageId?: string };
    }
  | {
      pathname: "/thread";
      params: { botId: string; name: string; messageId?: string };
    } {
  if (hit.routineId) {
    return {
      pathname: "/routine",
      params: { botId: hit.botId!, botName: hit.botName!, routineId: hit.routineId },
    };
  }
  const messageId = searchHitMessageId(hit);
  if (hit.groupId) {
    return {
      pathname: "/group-thread",
      params: {
        groupId: hit.groupId,
        name: hit.groupName ?? hit.title,
        ...(messageId ? { messageId } : {}),
      },
    };
  }
  return {
    pathname: "/thread",
    params: {
      botId: hit.botId!,
      name: hit.botName ?? hit.title,
      ...(messageId ? { messageId } : {}),
    },
  };
}
